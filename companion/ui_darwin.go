//go:build !windows
package main

import (
	"os/exec"
)

func showDashboardUI() {
	// Fallback to launching in standard web browser
	url := "http://127.0.0.1:18181/"
	_ = exec.Command("open", url).Start()
}
