# Sets up the tools this repo needs. The shell default is often Node 20, and corepack
# can't start pnpm 12. Source it from the repo root in every shell that runs repo tools:
#
#   source scripts/custom-env.sh
#
# rebuild-custom.sh does this on its own.
node24=$(ls -d "$HOME"/.nvm/versions/node/v24.* 2>/dev/null | sort -V | tail -1)
if [ -z "$node24" ]; then
  echo "Node 24 not found. Install it with: nvm install 24" >&2
  return 1
fi
export PATH="$node24/bin:$PATH"

# A shim rather than a function, because child processes call pnpm too.
pnpm_version=$(node -p 'require("./package.json").packageManager.split("@")[1]')
pnpm_shim_dir="${TMPDIR:-/tmp}/t3code-pnpm-$pnpm_version"
if [ ! -x "$pnpm_shim_dir/pnpm" ]; then
  mkdir -p "$pnpm_shim_dir"
  printf '#!/bin/sh\nexec npx --yes "pnpm@%s" "$@"\n' "$pnpm_version" >"$pnpm_shim_dir/pnpm"
  chmod +x "$pnpm_shim_dir/pnpm"
fi
export PATH="$pnpm_shim_dir:$PATH"
