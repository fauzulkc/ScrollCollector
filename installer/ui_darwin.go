//go:build !windows
package main

import (
	"fmt"
)

func launchInstallerUI() {
	// Fallback/Placeholder CLI for macOS/Linux platforms
	fmt.Println("====================================================")
	fmt.Println("  ScrollCollector Installer (macOS Fallback)")
	fmt.Println("====================================================")
	// Not fully implemented on macOS without cgo wrapper
	// We run it headlessly for now
	err := runInstallSequence()
	if err != nil {
		fmt.Printf("Installation failed: %v\n", err)
	} else {
		fmt.Println("Installation succeeded.")
	}
}
