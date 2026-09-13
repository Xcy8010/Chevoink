#!/bin/sh
# Install root:root 0755 at this fixed path; this wrapper has no privilege itself.
exec /usr/bin/sudo -n -- /usr/local/libexec/chevoink-document-import-launcher "$@"
