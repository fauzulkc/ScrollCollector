#!/bin/bash

# ScrollCollector Cross-Platform Installer Compiler
# Run this script to compile the standalone installers for Windows and macOS.

# Ensure we run from the project root directory
cd "$(dirname "$0")"

echo "===================================================="
echo "  ScrollCollector Cross-Compiler Suite"
echo "===================================================="
echo

# 1. Create temporary folders
mkdir -p installer/companion dist
cp icons/icon-16.png companion/icon-16.png
cp icons/icon.ico companion/icon.ico
cp install-guide.html installer/install-guide.html

# 2. Package the built extension (dist/ext: runtime files, vendored wasm, bundled models) into zip.
#    Zipping the source files instead ships without the models and the ui/ folder.
echo "[+] Building dist/ext and archiving it to installer/ScrollCollector.zip..."
node scripts/build-ext.mjs || { echo "[!] build-ext failed (run npm install and npm run fetch:models)."; exit 1; }
rm -f installer/ScrollCollector.zip
(cd dist/ext && zip -qr ../../installer/ScrollCollector.zip . -x "*.DS_Store")
zip -qj installer/ScrollCollector.zip install-guide.html README.md

if [ ! -f "installer/ScrollCollector.zip" ]; then
    echo "[!] Error generating ScrollCollector.zip archive."
    exit 1
fi

# ---------------------------------------------------------------------------
# WINDOWS COMPILATION (.exe)
# ---------------------------------------------------------------------------
echo
echo "[+] ------------------------------------------------"
echo "[+] Compiling Windows Suite..."
echo "[+] ------------------------------------------------"

# Compile Windows Standalone Installer (CLI/Server app)
echo "[+] Building ScrollCollectorInstaller.exe..."
GOOS=windows GOARCH=amd64 go build -ldflags="-H windowsgui" -o dist/ScrollCollectorInstaller.exe ./installer

if [ $? -eq 0 ]; then
    echo "[+] SUCCESS: Created dist/ScrollCollectorInstaller.exe"
else
    echo "[!] Windows Installer compilation failed."
    exit 1
fi

# ---------------------------------------------------------------------------
# macOS COMPILATION (Native Unix Binary)
# ---------------------------------------------------------------------------
echo
echo "[+] ------------------------------------------------"
echo "[+] Compiling macOS Suite..."
echo "[+] ------------------------------------------------"

# Compile macOS Standalone Installer
echo "[+] Building ScrollCollectorInstaller (macOS)..."
GOOS=darwin GOARCH=amd64 go build -o dist/ScrollCollectorInstaller ./installer

if [ $? -eq 0 ]; then
    echo "[+] SUCCESS: Created dist/ScrollCollectorInstaller"
else
    echo "[!] macOS Installer compilation failed."
fi

# CLEANUP
echo
echo "[+] Cleaning up temporary build artifacts..."
rm -f installer/ScrollCollector.zip
rm -f installer/install-guide.html
rm -rf installer/companion
rm -f companion/icon-16.png
rm -f companion/icon.ico

echo
echo "===================================================="
echo "  Build finished!"
echo "  Compiled targets:"
echo "  - Windows: ScrollCollectorInstaller.exe"
echo "  - macOS: ScrollCollectorInstaller (if built on Mac)"
echo "===================================================="
echo
