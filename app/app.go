// Package app is drawdown, heedle-ai's web UI, as a library (Run), so
// heedle can serve it too:
//
//	temporal server start-dev                  # in another terminal
//	go run ./cmd/drawdown -store ~/heedle-store.git
//
// then open http://127.0.0.1:8090. By default it also runs a loom worker
// in the same process, with draft's echo command, the hello world's source
// and assess commands, reed's browse (give -browser-image to use it) and
// pirn's ask and agent (set ANTHROPIC_API_KEY, and -agent-image for agent),
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
	browserNetwork := fs.String("browser-network", "", "Podman network browse containers join (default: Podman's)")
	askModel := fs.String("ask-model", pirn.DefaultModel, "Claude model ask and agent use (key from ANTHROPIC_API_KEY, or the keychain: heedle secret set ANTHROPIC_API_KEY)")
	agentImage := fs.String("agent-image", "", "content-pinned image ID agent steps run in (needs /bin/sh)")
	connectorsFile := fs.String("connectors", "", "a JSON file of the MCP servers agent steps may be granted (tokens by name: an environment variable, or a keychain secret set with `heedle secret set NAME`)")
	imageRegistry := fs.String("image-registry", "", "OCI repository (such as ghcr.io/acme/heedle-images) that (image … \"push\") pushes to, with the worker's podman login")
	agentRegistry := fs.String("agent-registry", "", "OCI repository (such as ghcr.io/acme/heedle-files) for agent files too big for the record, pushed with oras")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *store == "" {
		return errors.New("give -store DIR, e.g. -store ~/heedle-store.git")
	}

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
	if *runWorker {
		w := worker.New(c, *queue, reed.WorkerOptions(worker.Options{}))
		if err := reed.Register(reg, w, browser); err != nil {
			return err
		}
		// The key and the connectors are read again for every step, so a key
		// stored or a connector added while the worker runs needs no restart.
		if _, err := pirn.LookupSecret(ctx, vault, "ANTHROPIC_API_KEY"); err != nil {
			log.Printf("ANTHROPIC_API_KEY: %v; ask and agent steps will fail until the worker can read it", err)
		}
		claude := pirn.Claude{Model: *askModel, KeyFrom: func(ctx context.Context) (string, error) {
			return pirn.LookupSecret(ctx, vault, "ANTHROPIC_API_KEY")
		}}
		if err := pirn.Register(reg, w, claude); err != nil {
			return err
		}
		if err := bobbin.RegisterImage(reg, w, bobbin.Runner{}, imageRegistryFor(*imageRegistry)); err != nil {
			return err
		}
		connectors, err := readConnectors(*connectorsFile)
		if err != nil {
			return err
		}
		agent := pirn.Agent{Claude: claude, Runner: bobbin.Runner{}, Image: *agentImage, Registry: registryFor(*agentRegistry), Connectors: connectors, Vault: vault,
			LoadConnectors: func() (pirn.Connectors, error) { return readConnectors(*connectorsFile) }}
		if err := pirn.RegisterAgent(reg, w, agent); err != nil {
			return err
		}
		// Skills are the store's, at their newest when drawdown starts; each
		// run is checked against, and records, the versions it pins.
		lib := &treadle.Library{Store: s}
		skipped, err := treadle.Register(ctx, reg, w, agent, lib)
		if err != nil {
			return err
		}
		for _, err := range skipped {
			log.Printf("skill left out: %v", err)
		}
		loom.RegisterWith(w, &loom.Checker{Registry: reg, RegistryFor: func(ctx context.Context, p plan.Plan) (*registry.Registry, error) {
			return lib.Pinned(ctx, commands(), p)
		}}, &loom.Recorder{Store: s, Uses: lib.Uses})
		// Skills change only through a workflow on this worker (drawdown never
		// writes), never through a program.
		loom.RegisterSkills(w, loom.Skills{Library: lib, Create: creator(agent)})
		// The program writer: Claude with this worker's key, told about
		// its commands and the store's newest skills.
		loom.RegisterWriter(w, loom.Writer{Asker: claude, Commands: func(ctx context.Context) (*registry.Registry, []loom.Command, error) {
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
		}})
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
		Secrets:        vault,
		Skills:         &treadle.Library{Store: s},
		Commands:       commands,
		Store:          s,
		Ref:            *ref,
		Registry:       reg,
		Temporal:       drawdown.TemporalClient{Client: c, Queue: *queue},
		TemporalUI:     *temporalUI,
		Namespace:      *namespace,
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
