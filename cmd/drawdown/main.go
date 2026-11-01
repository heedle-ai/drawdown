// Command drawdown serves heedle-ai's web UI.
//
//	temporal server start-dev                  # in another terminal
//	go run ./cmd/drawdown -store ~/heedle-store.git
//
// then open http://127.0.0.1:8090. By default it also runs a loom worker
// in the same process, with draft's echo command and the hello world's
// source and assess commands, so one command is enough to try things out.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"

	"github.com/heedle-ai/drawdown"
	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/loom/examples/hello/shipment"
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

	if *runWorker {
		w := worker.New(c, *queue, worker.Options{})
		loom.Register(w, s, shipment.Registry())
		shipment.RegisterCommands(w, *sources)
		// Without Temporal the worker can't start; keep serving the
		// recorded history, and say why runs won't execute.
		if err := w.Start(); err != nil {
			log.Printf("worker not started, runs will wait for one: %v", err)
		} else {
			defer w.Stop()
		}
	}

	srv := &drawdown.Server{
		Store:      s,
		Ref:        *ref,
		Registry:   shipment.Registry(),
		Temporal:   drawdown.TemporalClient{Client: c, Queue: *queue},
		TemporalUI: *temporalUI,
		Namespace:  *namespace,
		Examples: map[string]string{
			"shipment": shipment.Program,
			"echo":     `(pipe (par (echo "a") (echo "b")) echo)`,
		},
	}
	if *hosts != "" {
		srv.Hosts = strings.Split(*hosts, ",")
	}
	fmt.Printf("drawdown on http://%s (store %s, queue %q, worker %v)\n", *listen, s.Dir(), *queue, *runWorker)
	hs := &http.Server{Addr: *listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(hs.ListenAndServe())
}
