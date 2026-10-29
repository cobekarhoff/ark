#!/bin/sh
# Stands in for `docker compose`: records its arguments so a test can check how Ark calls compose.
echo "$@" >> "$COMPOSE_LOG"
