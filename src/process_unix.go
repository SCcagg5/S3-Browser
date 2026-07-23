//go:build !windows

package main

import (
	"context"
	"errors"
	"os/exec"
	"syscall"
	"time"
)

func configureProcessGroup(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func runCommandWithContext(ctx context.Context, command *exec.Cmd) error {
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		if command.Process != nil {
			// Terminate the entire process group first so FFmpeg can close files
			// cleanly. Escalate after a short grace period; child processes must
			// never outlive a closed preview or a stopped server.
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGTERM)
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			if command.Process != nil {
				_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
			}
			<-done
		}
		return errors.Join(ctx.Err())
	}
}
