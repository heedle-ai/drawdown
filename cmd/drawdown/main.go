// Command drawdown serves heedle-ai's web UI: app.Run. heedle serves it
// too (heedle up, heedle ui).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"

	"github.com/heedle-ai/drawdown/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	// A second Ctrl-C while shutting down ends the process at once.
	go func() { <-ctx.Done(); stop() }()
	err := app.Run(ctx, os.Args[1:], os.Stdout)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "drawdown:", err)
		os.Exit(1)
	}
}
