// Command drawdown serves heedle-ai's web UI.
//
//	temporal server start-dev                  # in another terminal
//	go run ./cmd/drawdown -store ~/heedle-store.git
//
// then open http://127.0.0.1:8090. By default it also runs a loom worker
// in the same process, with draft's echo command, the hello world's source
// and assess commands, reed's browse (give -browser-image to use it) and
// pirn's ask (set ANTHROPIC_API_KEY to use it),
// so one command is enough to try things out.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"

	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
	"github.com/heedle-ai/pirn"
	"github.com/heedle-ai/reed"
	"github.com/heedle-ai/warp"
)

func main() {
	store := flag.String("store", "", "warp store directory (created if missing)")
	listen := flag.String("listen", "127.0.0.1:8090", "address to serve the UI on")
	address := flag.String("address", client.DefaultHostPort, "Temporal frontend address")
	temporalUI := flag.String("temporal-ui", "http://localhost:8233", "Temporal Web UI base URL, for links")
	queue := flag.String("queue", "loom", "Temporal task queue")
	namespace := flag.String("namespace", "default", "Temporal namespace")
	hosts := flag.String("hosts", "", "comma-separated extra host names the UI answers to (localhost and loopback always work)")
	ref := flag.String("ref", loom.DefaultRef, "warp ref runs are recorded on")
	runWorker := flag.Bool("worker", true, "also run a loom worker in this process")
	sources := flag.String("sources", shipment.SourcesDir(), "directory for the source command's files")
	browserImage := flag.String("browser-image", "", "reed browser image ID for the browse command (scripts/build-image.sh in heedle-ai/reed)")
	browserNetwork := flag.String("browser-network", "", "Podman network browse containers join (default: Podman's)")
	askModel := flag.String("ask-model", pirn.DefaultModel, "Claude model the ask command uses (key from ANTHROPIC_API_KEY)")
	flag.Parse()
	if *store == "" {
		log.Fatal("give -store DIR, e.g. -store ~/heedle-store.git")
	}
	ctx := context.Background()

	s, err := warp.Init(ctx, *store)
	if err != nil {
		log.Fatal(err)
	}
	if err := warp.CheckRef(ctx, *ref); err != nil {
		log.Fatal(err)
	}
	// Lazy: connect on first use, so the UI and its recorded history still
	// work while Temporal is down.
	c, err := client.NewLazyClient(client.Options{HostPort: *address, Namespace: *namespace})
	if err != nil {
		log.Fatal(err)
	}
	defer c.Close()

	reg := shipment.Registry()
	browser := reed.Browser{Image: *browserImage, Network: *browserNetwork}
	if *runWorker {
		w := worker.New(c, *queue, reed.WorkerOptions(worker.Options{}))
		if err := reed.Register(reg, w, browser); err != nil {
			log.Fatal(err)
		}
		if err := pirn.Register(reg, w, pirn.Claude{APIKey: os.Getenv("ANTHROPIC_API_KEY"), Model: *askModel}); err != nil {
			log.Fatal(err)
		}
		loom.Register(w, s, reg)
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
		reg.MustRegister(reed.BuiltinSpec())
		reg.MustRegister(pirn.BuiltinSpec())
	}
	srv := &drawdown.Server{
		Store:      s,
		Ref:        *ref,
		Registry:   reg,
		Temporal:   drawdown.TemporalClient{Client: c, Queue: *queue},
		TemporalUI: *temporalUI,
		Namespace:  *namespace,
		Examples: map[string]string{
			"shipment": shipment.Program,
			"echo":     `(pipe (par (echo "a") (echo "b")) echo)`,
			"ask":      AskExample,
		},
	}
	if *hosts != "" {
		srv.Hosts = strings.Split(*hosts, ",")
	}
	fmt.Printf("drawdown on http://%s (store %s, queue %q, worker %v)\n", *listen, s.Dir(), *queue, *runWorker)
	hs := &http.Server{Addr: *listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(hs.ListenAndServe())
}

// AskExample is the shipment question answered by Claude instead of fixed
// rules: the three sources in parallel, then ask. It needs ANTHROPIC_API_KEY
// where the worker runs.
const AskExample = `(pipe
  (par (source "weather") (source "carrier") (source "factory"))
  (ask "Will the shipment be late? Answer yes or no first, then explain in two sentences, citing the sources that decide it."))`
