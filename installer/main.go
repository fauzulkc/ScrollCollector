package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed install-guide.html
var installGuideHTML []byte

//go:embed ScrollCollector.zip
var extensionZip []byte

var (
	installPath  string
	hasChrome    bool
)

// ChromeExtensionID is the ID of the extension on the Chrome Web Store.
// Replace this with your actual published extension ID to trigger native browser install prompts.
const ChromeExtensionID = "obgignpijgkbhhggkbhdfhbhjfadabdc"

// EdgeExtensionID is the ID of the extension on the Edge Add-ons Store.
const EdgeExtensionID = "obgignpijgkbhhggkbhdfhbhjfadabdc"

func main() {
	// Initialize installation directory
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "windows" {
		installPath = filepath.Join(home, "ScrollCollector")
	} else {
		installPath = "/Applications/ScrollCollector"
	}

	// Perform browser detection
	detectBrowsers()

	// Launch native installer UI (WebView2 on Windows, browser on macOS)
	launchInstallerUI()
}

func detectBrowsers() {
	if runtime.GOOS == "windows" {
		pf := os.Getenv("ProgramFiles")
		pf86 := os.Getenv("ProgramFiles(x86)")
		lad := os.Getenv("LocalAppData")

		hasChrome = exists(filepath.Join(pf, `Google\Chrome\Application\chrome.exe`)) ||
			exists(filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`)) ||
			exists(filepath.Join(lad, `Google\Chrome\Application\chrome.exe`))
	} else {
		hasChrome = exists("/Applications/Google Chrome.app")
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", "start", url)
	} else {
		cmd = exec.Command("open", url)
	}
	_ = cmd.Start()
}

func runInstallSequence() error {
	// 1. Extract extension files
	err := extractExtension()
	if err != nil {
		return err
	}

	// 2. Guided Extension Installation (Open Explorer)
	launchGuidedInstallation()

	return nil
}

func extractExtension() error {
	// Recreate folders
	_ = os.RemoveAll(installPath)
	err := os.MkdirAll(filepath.Join(installPath, "ScrollCollector Extension"), 0755)
	if err != nil {
		return err
	}

	// Read zip payload
	r, err := zip.NewReader(bytes.NewReader(extensionZip), int64(len(extensionZip)))
	if err != nil {
		return err
	}

	for _, f := range r.File {
		fpath := filepath.Join(installPath, "ScrollCollector Extension", f.Name)

		// Prevent Zip Slip vulnerability
		if !strings.HasPrefix(fpath, filepath.Clean(filepath.Join(installPath, "ScrollCollector Extension"))+string(os.PathSeparator)) {
			return fmt.Errorf("illegal file path: %s", fpath)
		}

		if f.FileInfo().IsDir() {
			_ = os.MkdirAll(fpath, os.ModePerm)
			continue
		}

		if err := os.MkdirAll(filepath.Dir(fpath), os.ModePerm); err != nil {
			return err
		}

		outFile, err := os.OpenFile(fpath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return err
		}

		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return err
		}

		_, err = io.Copy(outFile, rc)
		outFile.Close()
		rc.Close()

		if err != nil {
			return err
		}
	}
	return nil
}

func launchGuidedInstallation() {
	if runtime.GOOS == "windows" {
		// Open Windows Explorer and select the Extension folder
		targetFolder := filepath.Join(installPath, "ScrollCollector Extension")
		cmdExp := exec.Command("explorer.exe", "/select,", targetFolder)
		_ = cmdExp.Start()
	} else {
		targetFolder := filepath.Join(installPath, "ScrollCollector Extension")
		_ = exec.Command("open", "-R", targetFolder).Start()
	}
}
