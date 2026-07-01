//go:build !windows
package main

import _ "embed"

//go:embed icon-16.png
var trayIcon []byte
