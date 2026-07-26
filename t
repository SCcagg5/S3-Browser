bash -lc '
set -euo pipefail

cd "$HOME/Documents/Work/S3-Browser"

printf "\n== Cleaning obsolete files ==\n"

rm -f \
  project.zip \
  docs/AUDIT_INITIAL.md \
  docs/CORRECTIONS_UI_V2.md \
  docs/CORRECTIONS_UI_V3.md \
  docs/PDFJS_LOCAL.md \
  docs/IMPLEMENTATION_REPORT*.md


find . -type f \( \
  -name ".DS_Store" -o \
  -name "Thumbs.db" -o \
  -name "*.tmp" -o \
  -name "*.bak" -o \
  -name "*~" \
\) -delete

find . -type d -empty -not -path "./.git/*" -delete

printf "\n== Running backend tests ==\n"
(
  cd src
  gofmt -w .
  go test -count=1 ./...
  go vet ./...
)

printf "\n== Running frontend tests ==\n"
for test_file in test/*.js; do
  node "$test_file"
done

printf "\n== Replacing main ==\n"
git checkout -B main
git add -A

if git diff --cached --quiet; then
  git commit --allow-empty -m "Release v0.1.0"
else
  git commit -m "Release v0.1.0"
fi

git push --force origin main

printf "\n== Recreating v0.1.0 ==\n"
gh release delete v0.1.0 --yes --cleanup-tag 2>/dev/null || true
git tag -d v0.1.0 2>/dev/null || true
git push origin --delete v0.1.0 2>/dev/null || true

git tag -a v0.1.0 -m "v0.1.0"
git push --force origin v0.1.0

gh release create v0.1.0 \
  --verify-tag \
  --title "v0.1.0" \
  --generate-notes

printf "\nRelease v0.1.0 created successfully.\n"
'