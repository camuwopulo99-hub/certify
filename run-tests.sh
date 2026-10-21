#!/bin/sh
# 1) server logic (upload / sync / duplicates / pairing / system check) against fake Google + fake DB
node --experimental-strip-types --no-warnings --test tests/core.test.mjs || exit 1
# 2) real browser: student + faculty pages against the same logic (needs: pip install playwright && playwright install chromium)
python3 tests/e2e.py
