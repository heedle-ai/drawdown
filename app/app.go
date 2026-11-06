// Package app is drawdown, heedle-ai's web UI, as a library (Run), so
// heedle can serve it too:
//
//	temporal server start-dev                  # in another terminal
//	go run ./cmd/drawdown -store ~/heedle-store.git
//
// then open http://127.0.0.1:8090. By default it also runs a loom worker
// in the same process, with draft's echo command, the hello world's source
// and assess commands, reed's browse (give -browser-image to use it) and
// pirn's ask, agent and act (set ANTHROPIC_API_KEY, and -agent-image for
// agent, -browser-agent-image for act),
// so one command is enough to try things out.
package app

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"

	"github.com/heedle-ai/bobbin"
	"github.com/heedle-ai/draft/registry"
	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/reed"
	"github.com/heedle-ai/shuttle/plan"
	"github.com/heedle-ai/treadle"
	"github.com/heedle-ai/warp"
)

// Run serves the UI (and, unless -worker=false, a loom worker) with the
// flags in args, until ctx ends or serving fails.
func Run(ctx context.Context, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("drawdown", flag.ContinueOnError)
	fs.SetOutput(out)
	store := fs.String("store", "", "warp store directory (created if missing)")
	listen := fs.String("listen", "127.0.0.1:8090", "address to serve the UI on")
	address := fs.String("address", client.DefaultHostPort, "Temporal frontend address")
	temporalUI := fs.String("temporal-ui", "http://localhost:8233", "Temporal Web UI base URL, for links")
	queue := fs.String("queue", "loom", "Temporal task queue")
	namespace := fs.String("namespace", "default", "Temporal namespace")
	hosts := fs.String("hosts", "", "comma-separated extra host names the UI answers to (localhost and loopback always work)")
	ref := fs.String("ref", loom.DefaultRef, "warp ref runs are recorded on")
	runWorker := fs.Bool("worker", true, "also run a loom worker in this process")
	sources := fs.String("sources", shipment.SourcesDir(), "directory for the source command's files")
	browserImage := fs.String("browser-image", "", "reed browser image ID for the browse command (scripts/build-image.sh in heedle-ai/reed)")
	browserAgentImage := fs.String("browser-agent-image", "", "reed browser-agent image ID for the act command (Playwright MCP and Chromium; roadmap 9.5)")
	browserNetwork := fs.String("browser-network", "", "Podman network browse and act containers join (default: Podman's)")
	askModel := fs.String("ask-model", pirn.DefaultModel, "Claude model ask and agent use (key from ANTHROPIC_API_KEY, or the keychain: heedle secret set ANTHROPIC_API_KEY)")
	agentImage := fs.String("agent-image", "", "content-pinned image ID agent steps run in (needs /bin/sh)")
	connectorsFile := fs.String("connectors", "", "a JSON file of the MCP servers agent steps may be granted (tokens by name: an environment variable, or a keychain secret set with `heedle secret set NAME`)")
	imageRegistry := fs.String("image-registry", "", "OCI repository (such as ghcr.io/acme/heedle-images) that (image … \"push\") pushes to, with the worker's podman login")
	homes := fs.String("homes", "", "the folder where running heedle homes say so (heedle up gives it): while another home runs, the System page removes no old images")
	keepImages := fs.String("keep-images", "", "the images heedle's release pins, comma-separated (heedle up gives them): the System page never removes them or the worker's own, and removes none without them")
	pricesFile := fs.String("prices", "", "your prices file, overriding the built-in prices model by model (USD per million tokens; default: prices.json beside -connectors, else ~/.heedle/prices.json)")
	agentRegistry := fs.String("agent-registry", "", "OCI repository (such as ghcr.io/acme/heedle-files) for agent files too big for the record, pushed with oras")
	memoryFile := fs.String("memory", "", "the file of what heedle remembers about you, sent to Claude with every request to the front door (default: memory.json beside the -connectors file, if given)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *memoryFile == "" && *connectorsFile != "" {
		// heedle up gives -connectors ~/.heedle/connectors.json, so its
		// memory is ~/.heedle/memory.json (roadmap 10.1).
		*memoryFile = filepath.Join(filepath.Dir(*connectorsFile), "memory.json")
	}
	if *store == "" {
		return errors.New("give -store DIR, e.g. -store ~/heedle-store.git")
	}
	*pricesFile = pricesPath(*pricesFile, *connectorsFile, os.UserHomeDir)

	s, err := warp.Init(ctx, *store)
	if err != nil {
		return err
	}
	if err := warp.CheckRef(ctx, *ref); err != nil {
		return err
	}
	// Lazy: connect on first use, so the UI and its recorded history still
	// work while Temporal is down.
	c, err := client.NewLazyClient(client.Options{HostPort: *address, Namespace: *namespace})
	if err != nil {
		return err
	}
	defer c.Close()

	reg := shipment.Registry()
	browser := reed.Browser{Image: *browserImage, Network: *browserNetwork}
	// Keys come from the environment, else the keychain (heedle secret set,
	// or the Connectors page).
	vault := pirn.Keychain{}
	// Steps read keys through this, which refreshes a signed-in
	// connector's token; the front door's ready check reads them the
	// same way (review 33).
	stepKeys := &drawdown.OAuthVault{Keys: vault}
	if *runWorker {
		// Every container a step starts says this store's home, so two
		// heedle homes running at once each tidy only their own (roadmap
		// 9.2.1, DRAW-520); a stopping worker lets steps finish and note
		// their calls (roadmap 10.4.1, DRAW-324).
		w := worker.New(c, *queue, reed.WorkerOptions(worker.Options{BackgroundActivityContext: loom.WorkerContext(*store), WorkerStopTimeout: loom.WorkerStopTimeout}))
		// Every step's containers are labelled with its run and step
		// (roadmap 9.2, DRAW-505).
		// and every attempt of a Claude step is counted in the usage
		// ledger (roadmap 10.4.1, DRAW-320).
		steps := loom.Labelled(loom.Counted(w, s))
		if err := reed.Register(reg, steps, browser); err != nil {
			return err
		}
		// The key and the connectors are read again for every step, so a key
		// stored or a connector added while the worker runs needs no restart.
		if _, err := pirn.LookupSecret(ctx, vault, "ANTHROPIC_API_KEY"); err != nil {
			log.Printf("ANTHROPIC_API_KEY: %v; ask and agent steps will fail until the worker can read it", err)
		}
		// Each keeps what it last read if a read fails: a keychain locked
		// for a moment, or a connectors file mid-save (review 27).
		key := pirn.LastGood(func() (string, error) {
			return pirn.LookupSecret(context.Background(), vault, "ANTHROPIC_API_KEY")
		})
		loadConnectors := pirn.LastGood(func() (pirn.Connectors, error) { return readConnectors(*connectorsFile) })
		claude := pirn.Claude{Model: *askModel, KeyFrom: func(context.Context) (string, error) { return key() }}
		if err := pirn.Register(reg, steps, claude); err != nil {
			return err
		}
		if err := bobbin.RegisterImage(reg, steps, bobbin.Runner{}, imageRegistryFor(*imageRegistry)); err != nil {
			return err
		}
		// A bad file doesn't stop the UI that shows what's wrong with it
		// (review 27); steps fail until it's fixed.
		connectors, err := loadConnectors()
		if err != nil {
			log.Printf("connectors: %v", err)
			connectors = nil
		}
		if _, err := os.Stat(*connectorsFile); *connectorsFile != "" && err != nil {
			log.Printf("connectors: %s isn't there yet, so no connectors until it is", *connectorsFile)
		}
		agent := pirn.Agent{Claude: claude, Runner: bobbin.Runner{}, Image: *agentImage, Registry: registryFor(*agentRegistry), Connectors: connectors, Vault: stepKeys,
			LoadConnectors: loadConnectors}
		if err := pirn.RegisterAgent(reg, steps, agent); err != nil {
			return err
		}
		act := pirn.Act{Confirm: loom.Confirmer(c), Profile: pirn.ProfileFrom(vault), Claude: claude, Browser: pirn.ReedBrowser{Browser: reed.Browser{Image: *browserAgentImage, Network: *browserNetwork}}, Image: *browserAgentImage,
			Script: loom.Scripts(c, s)} // the program's last script, replayed without Claude (roadmap 9.9)
		if err := pirn.RegisterAct(reg, steps, act); err != nil {
			return err
		}
		// Skills are the store's, at their newest when drawdown starts; each
		// run is checked against, and records, the versions it pins.
		lib := &treadle.Library{Store: s}
		skipped, err := treadle.Register(ctx, reg, steps, agent, lib)
		if err != nil {
			return err
		}
		for _, err := range skipped {
			log.Printf("skill left out: %v", err)
		}
		loom.RegisterWith(w, &loom.Checker{Registry: reg, RegistryFor: func(ctx context.Context, p plan.Plan) (*registry.Registry, error) {
			return lib.Pinned(ctx, commands(), p)
		}}, &loom.Recorder{Store: s, Uses: lib.Uses, Schedules: loom.TemporalSchedules{Client: c}, PricesFile: *pricesFile})
		if _, err := loom.ReadPrices(*pricesFile); err != nil {
			log.Print(err)
		}
		// A new month resumes the schedules their budget paused that are
		// to resume (roadmap 10.4), watched or not.
		go loom.ResumeBudgetsEvery(ctx, c, *queue, loom.ResumeBudgetsLook, log.Printf)
		// Skills change only through a workflow on this worker (drawdown never
		// writes), never through a program.
		loom.RegisterSkills(w, loom.Skills{Library: lib, Create: creator(agent)})
		// The program writer and the front door (ask): Claude with this
		// worker's key, told about its commands and the store's newest
		// skills; a proposal says whether it can run now, from this worker's
		// skills, connectors and keys.
		writer := loom.Writer{Asker: claude, Ledger: s, Commands: func(ctx context.Context) (*registry.Registry, []loom.Command, error) {
			reg := commands()
			if _, err := lib.AddTo(ctx, reg); err != nil {
				return nil, nil, err
			}
			known := map[string]loom.Command{}
			for k, v := range loom.BuiltinCommands {
				known[k] = v
			}
			skills, _, err := lib.Skills(ctx)
			if err != nil {
				return nil, nil, err
			}
			for _, sk := range skills {
				known[sk.Name] = loom.Command{Args: "(" + sk.Name + ` "arg" ...)`, About: "A skill: " + sk.Description}
			}
			return reg, loom.Commands(reg, known), nil
		}, Ready: func(ctx context.Context, p plan.Plan) (loom.Readiness, error) {
			cs, err := loadConnectors()
			if err != nil {
				return loom.Readiness{}, err
			}
			return loom.CheckReady(ctx, p, lib, loom.Worker{Connectors: cs, Keys: agent.Vault, Agents: agent.Image != "", Browsers: *browserImage != "", BrowserAgents: *browserAgentImage != ""})
		}, MemoryFile: *memoryFile}
		loom.RegisterWriter(w, writer)
		loom.RegisterAsk(w, writer)
		shipment.RegisterCommands(w, *sources)
		// Without Temporal the worker can't start; keep serving the
		// recorded history, and say why runs won't execute.
		if err := w.Start(); err != nil {
			log.Printf("worker not started, runs will wait for one: %v", err)
		} else {
			defer w.Stop()
		}
	}

	if !*runWorker {
		reg = commands()
		skipped, err := (&treadle.Library{Store: s}).AddTo(ctx, reg)
		if err != nil {
			return err
		}
		for _, err := range skipped {
			log.Printf("skill left out: %v", err)
		}
	}
	srv := &drawdown.Server{
		Connectors:     func() (pirn.Connectors, error) { return readConnectors(*connectorsFile) },
		ConnectorsFile: *connectorsFile,
		MemoryFile:     *memoryFile,
		PricesFile:     *pricesFile,
		StoreDir:       s.Dir(),
		Secrets:        vault,
		StepKeys:       stepKeys,
		Agents:         *agentImage != "",
		Browsers:       *browserImage != "",
		BrowserAgents:  *browserAgentImage != "",
		Skills:         &treadle.Library{Store: s},
		Commands:       commands,
		Store:          s,
		Ref:            *ref,
		Registry:       reg,
		Temporal:       drawdown.TemporalClient{Client: c, Queue: *queue},
		TemporalUI:     *temporalUI,
		Namespace:      *namespace,
		System:         drawdown.PodmanSystem{Temporal: c, Pins: kept(*keepImages), Kept: kept("", *browserImage, *agentImage, *browserAgentImage), Mac: runtime.GOOS == "darwin", Homes: *homes, Home: bobbin.HomeOf(*store)},
		Examples: map[string]string{
			"shipment": shipment.Program,
			"echo":     `(pipe (par (echo "a") (echo "b")) echo)`,
			"ask":      AskExample,
		},
	}
	if *hosts != "" {
		srv.Hosts = strings.Split(*hosts, ",")
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "drawdown on http://%s (store %s, queue %q, worker %v)\n", ln.Addr(), s.Dir(), *queue, *runWorker)
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- hs.Serve(ln) }()
	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}
	// Finish the requests in flight before the worker and the Temporal
	// client stop, and before Run returns (review 21).
	shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = hs.Shutdown(shut)
	<-served
	return err
}

// AskExample is the shipment question answered by Claude instead of fixed
// rules: the three sources in parallel, then ask. It needs ANTHROPIC_API_KEY
// where the worker runs.
const AskExample = `(pipe
  (par (source "weather") (source "carrier") (source "factory"))
  (ask "Will the shipment be late? Answer yes or no first, then explain in two sentences, citing the sources that decide it."))`

// registryFor is the registry agent files too big for the record go to,
// or nil (they're skipped) without one.
func registryFor(repo string) *pirn.Registry {
	if repo == "" {
		return nil
	}
	return &pirn.Registry{Repo: repo}
}

// imageRegistryFor is where (image … "push") pushes, or nil: then such
// steps fail with ImageSetup.
func imageRegistryFor(repo string) *bobbin.ImageRegistry {
	if repo == "" {
		return nil
	}
	return &bobbin.ImageRegistry{Repo: repo}
}

// commands is every command a worker here has, but skills: the hello
// world's, reed's browse, pirn's ask and agent, and bobbin's image.
func commands() *registry.Registry {
	reg := shipment.Registry()
	reg.MustRegister(reed.BuiltinSpec())
	reg.MustRegister(pirn.BuiltinSpec())
	reg.MustRegister(pirn.AgentBuiltinSpec())
	reg.MustRegister(pirn.ActBuiltinSpec())
	reg.MustRegister(bobbin.ImageBuiltinSpec())
	return reg
}

// readConnectors reads the worker's connectors file, if it has one: a
// file that isn't there (yet) is no connectors.
func readConnectors(path string) (pirn.Connectors, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil // not made yet: no connectors until it is
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return pirn.ReadConnectors(f)
}

// creator creates skills with the worker's agent, if it has an image.
func creator(a pirn.Agent) func(context.Context, string) (map[string][]byte, error) {
	if a.Image == "" {
		return nil
	}
	return func(ctx context.Context, description string) (map[string][]byte, error) {
		files, _, err := treadle.Create(ctx, a.Run, description)
		return files, err
	}
}

// kept is the images the System page never removes: those listed (heedle
// up's pins) and the worker's own.
func kept(list string, worker ...string) []string {
	var out []string
	for _, r := range append(strings.Split(list, ","), worker...) {
		if r = strings.TrimSpace(r); r != "" {
			out = append(out, r)
		}
	}
	return out
}

// pricesPath is the prices file: the one given, else prices.json beside
// the connectors file, else ~/.heedle/prices.json, as loom's worker and
// heedle costs read (review 48: the UI and the worker estimated with
// different prices).
func pricesPath(prices, connectors string, home func() (string, error)) string {
	switch {
	case prices != "":
		return prices
	case connectors != "":
		return filepath.Join(filepath.Dir(connectors), "prices.json")
	}
	if h, err := home(); err == nil {
		return filepath.Join(h, ".heedle", "prices.json")
	}
	return ""
}
