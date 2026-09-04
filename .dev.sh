#!/bin/sh
# The local gate runs against the Neon preview branch, not tests.
set -a; PREVIEW=$(grep '^PREVIEW_DATABASE_URL=' .env.local | cut -d= -f2-); set +a
DATABASE_URL="$PREVIEW" exec npx next dev -p 3102
