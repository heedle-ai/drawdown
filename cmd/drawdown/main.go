// Command drawdown serves heedle-ai's web UI: app.Run. heedle serves it
// too (heedle up, heedle ui).
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/heedle-ai/drawdown/app"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := app.Run(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "drawdown:", err)
		os.Exit(1)
	}
}
