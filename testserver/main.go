// Package main implements a minimal wspulse test server for client-ts
// integration tests. Behaviour is controlled via query parameters:
//
//   - ?reject=1        → ConnectFunc returns an error (HTTP 401)
//   - ?room=<id>       → assigns the connection to room <id> (default: "test")
//   - ?id=<id>         → sets connectionID (default: auto-generated UUID)
//   - ?echo=1          → echoes every inbound frame back to sender (default: on)
//   - ?broadcast=1     → broadcasts inbound frames to all connections in room
//
// The server prints "READY:<port>" to stderr once listening. The global-setup
// script in vitest reads this line to discover the port.
package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	wspulse "github.com/wspulse/server"
	"go.uber.org/zap"
)

func main() {
	logger, _ := zap.NewDevelopment()

	srv := wspulse.NewServer(
		func(r *http.Request) (roomID, connectionID string, err error) {
			if r.URL.Query().Get("reject") == "1" {
				return "", "", fmt.Errorf("rejected by test server")
			}
			room := r.URL.Query().Get("room")
			if room == "" {
				room = "test"
			}
			return room, r.URL.Query().Get("id"), nil
		},
		wspulse.WithOnMessage(func(conn wspulse.Connection, f wspulse.Frame) {
			// Echo back by default.
			if err := conn.Send(f); err != nil {
				logger.Warn("echo send failed", zap.Error(err))
			}
		}),
		wspulse.WithLogger(logger),
		wspulse.WithMaxMessageSize(1<<20), // 1 MiB
	)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		logger.Fatal("listen failed", zap.Error(err))
	}

	port := ln.Addr().(*net.TCPAddr).Port
	fmt.Fprintf(os.Stderr, "READY:%d\n", port)

	// Graceful shutdown on SIGINT/SIGTERM.
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		logger.Info("shutting down")
		srv.Close()
		_ = ln.Close()
	}()

	if err := http.Serve(ln, srv); err != nil {
		// net.ErrClosed is expected after ln.Close().
		logger.Debug("http.Serve exited", zap.Error(err))
	}
}
