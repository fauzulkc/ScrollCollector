#!/bin/bash

# ScrollCollector macOS Package Compiler
# Run this on a Mac to compile ScrollCollector.pkg

# Ensure the script runs from the directory it is located in
cd "$(dirname "$0")"

echo "===================================================="
echo "  ScrollCollector Package Builder for macOS"
echo "===================================================="
echo

# 1. Create temporary directory structure
TEMP_DIR=$(mktemp -d)
PAYLOAD_DIR="$TEMP_DIR/payload"
SCRIPTS_DIR="$TEMP_DIR/scripts"

mkdir -p "$PAYLOAD_DIR"
mkdir -p "$SCRIPTS_DIR"

echo "[+] Copying extension files to temporary payload..."
# Copy only runtime files, excluding developer configurations and scripts
rsync -av --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='test' \
    --exclude='mocks' \
    --exclude='scratch' \
    --exclude='.gitignore' \
    --exclude='package.json' \
    --exclude='package-lock.json' \
    --exclude='test.mjs' \
    --exclude='Installer.cs' \
    --exclude='build-exe.bat' \
    --exclude='build-pkg.sh' \
    --exclude='ScrollCollectorInstaller.exe' \
    --exclude='ScrollCollector.pkg' \
    --exclude='ScrollCollector.zip' \
    ./ "$PAYLOAD_DIR/"

echo "[+] Generating installer scripts..."
# 2. Write the postinstall script
cat << 'EOF' > "$SCRIPTS_DIR/postinstall"
#!/bin/bash

# Postinstall action runs as root, but we launch GUI applications
# and clipboard utilities in the context of the logged-in user.

# Get current console/GUI username
console_user=$(stat -f '%Su' /dev/console)

if [ -n "$console_user" ] && [ "$console_user" != "root" ]; then
    # Open setup guide
    sudo -u "$console_user" open "/Applications/ScrollCollector/install-guide.html"
fi

exit 0
EOF

# Make postinstall script executable
chmod +x "$SCRIPTS_DIR/postinstall"

echo "[+] Compiling package ScrollCollector.pkg..."
# 3. Compile the package installer
pkgbuild --root "$PAYLOAD_DIR" \
         --install-location "/Applications/ScrollCollector" \
         --scripts "$SCRIPTS_DIR" \
         --identifier com.scrollcollector.extension \
         --version 2.0.0 \
         ./ScrollCollector.pkg

if [ $? -eq 0 ]; then
    echo
    echo "===================================================="
    echo "  SUCCESS: ScrollCollector.pkg created!"
    echo "===================================================="
    echo
else
    echo
    echo "[!] Compilation failed. Please check build errors."
fi

# 4. Clean up
rm -rf "$TEMP_DIR"
