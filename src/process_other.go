//go:build windows

package main

import (
	"context"
	"os/exec"
)

func configureProcessGroup(command *exec.Cmd) {}

func runCommandWithContext(ctx context.Context, command *exec.Cmd) error {
	return command.Run()
}
