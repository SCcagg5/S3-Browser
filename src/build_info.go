package main

import (
	"runtime/debug"
	"strings"
)

// These values are replaced by the release build through -ldflags. They stay
// readable in development builds so the frontend can always expose a useful
// identity without consulting the network or the source tree at runtime.
var (
	buildVersion = "dev"
	buildCommit  = "unknown"
	buildDate    = ""
)

type buildInfoResponse struct {
	Version     string `json:"version"`
	Commit      string `json:"commit"`
	ShortCommit string `json:"shortCommit"`
	Date        string `json:"date,omitempty"`
	Display     string `json:"display"`
}

func currentBuildInfo() buildInfoResponse {
	version := strings.TrimSpace(buildVersion)
	commit := strings.TrimSpace(buildCommit)
	date := strings.TrimSpace(buildDate)

	if info, ok := debug.ReadBuildInfo(); ok {
		if version == "" || version == "dev" {
			if value := strings.TrimSpace(info.Main.Version); value != "" && value != "(devel)" {
				version = value
			}
		}
		for _, setting := range info.Settings {
			switch setting.Key {
			case "vcs.revision":
				if commit == "" || commit == "unknown" {
					commit = strings.TrimSpace(setting.Value)
				}
			case "vcs.time":
				if date == "" {
					date = strings.TrimSpace(setting.Value)
				}
			}
		}
	}
	if version == "" {
		version = "dev"
	}
	if commit == "" {
		commit = "unknown"
	}
	shortCommit := commit
	if len(shortCommit) > 9 {
		shortCommit = shortCommit[:9]
	}
	display := version
	if shortCommit != "" && shortCommit != "unknown" {
		display += " · " + shortCommit
	}
	return buildInfoResponse{
		Version:     version,
		Commit:      commit,
		ShortCommit: shortCommit,
		Date:        date,
		Display:     display,
	}
}
