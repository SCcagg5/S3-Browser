package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"
	"time"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "healthcheck":
			runHealthcheck(os.Args[2:])
			return
		case "version", "--version", "-version":
			info := currentBuildInfo()
			fmt.Printf("s3-browser %s\n", info.Display)
			return
		}
	}

	flags := flag.NewFlagSet("s3-browser", flag.ExitOnError)
	var configPath string
	flags.StringVar(&configPath, "c", "config.hcl", "path to the HCL configuration file")
	flags.StringVar(&configPath, "config", "config.hcl", "path to the HCL configuration file")
	_ = flags.Parse(os.Args[1:])

	cfg, err := loadRuntimeConfig(configPath)
	if err != nil {
		log.Fatal(err)
	}
	if cfg.Runtime.MemoryLimitBytes > 0 {
		debug.SetMemoryLimit(cfg.Runtime.MemoryLimitBytes)
	}
	app, err := newApplication(cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer app.close()

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           app.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 20,
	}
	if cfg.Runtime.LogMode == logModeDetailed {
		log.Printf("loaded configuration from %s", cfg.SourceName)
	}
	log.Printf("object browser listening on %s with %d bucket(s) using %d auth configuration(s); stateless=true access=%s", cfg.Listen, len(cfg.Buckets), len(cfg.Authentications), cfg.Runtime.AccessMode)
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.ListenAndServe()
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case sig := <-signals:
		log.Printf("received %s; shutting down", sig)
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
			_ = server.Close()
		}
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}
}

func runHealthcheck(args []string) {
	flags := flag.NewFlagSet("healthcheck", flag.ExitOnError)
	var configPath string
	flags.StringVar(&configPath, "c", "", "optional HCL configuration used to derive the health endpoint")
	flags.StringVar(&configPath, "config", "", "optional HCL configuration used to derive the health endpoint")
	checkURL := flags.String("url", "", "health endpoint URL")
	_ = flags.Parse(args)

	if *checkURL == "" && strings.TrimSpace(configPath) != "" {
		cfg, err := loadRuntimeConfig(configPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "healthcheck config: %v\n", err)
			os.Exit(1)
		}
		*checkURL = healthURLFromListen(cfg.Listen)
	}
	if *checkURL == "" {
		*checkURL = "http://127.0.0.1:8080/healthz"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, *checkURL, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck request: %v\n", err)
		os.Exit(1)
	}
	client := newStorageHTTPClient(false)
	defer closeHTTPClient(client)
	resp, err := client.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "healthcheck failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "healthcheck failed: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}
}

func healthURLFromListen(listen string) string {
	listen = strings.TrimSpace(listen)
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		if strings.HasPrefix(listen, ":") {
			return "http://127.0.0.1" + listen + "/healthz"
		}
		return "http://127.0.0.1:8080/healthz"
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/healthz"
}
