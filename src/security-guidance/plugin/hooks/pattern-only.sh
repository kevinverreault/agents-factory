#!/usr/bin/env bash
# The factory's launcher for the upstream hook: runs its Python launcher
# (the first argument) on the hook script (the rest) with every review that
# calls a model turned off. The pattern warnings need no credentials, cost no
# usage, and never wake a run that has ended, and with the reviews off the
# hook never installs the Python Agent SDK they need.
export ENABLE_CODE_SECURITY_REVIEW=0
exec bash "$@"
