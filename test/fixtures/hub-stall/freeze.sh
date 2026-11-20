#!/bin/sh
# freeze.sh <pid> <seconds>: stops the process, holds it for the time, continues it (ARK-T700, ARK-T701).
kill -STOP "$1"
sleep "$2"
kill -CONT "$1"
