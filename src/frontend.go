package main

import (
	"embed"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"sort"
	"strings"
)

// The server embeds more than one browser interface. "default" is the tree in public/. Each other name is a tree in
// frontends/<name>/: "portal" is the shell of the portal with the dense tables of ClickHouse Dash. The HCL key
// server.frontend selects one tree at start. The routes, the API and the security headers are the same for all trees.

//go:embed frontends
var embeddedFrontends embed.FS

const (
	frontendDefault = "default"
	frontendPortal  = "portal"
)

// frontendNames is the closed list of values for server.frontend, in the order of the documentation.
var frontendNames = []string{frontendDefault, frontendPortal}

// sharedFrontendPrefix is the one part of the default tree that an alternative tree also gives: the vendored
// third-party scripts (PDF.js, highlight.js, marked). The alternative tree does not copy them, so the binary
// contains them one time.
const sharedFrontendPrefix = "assets/vendor"

// parseFrontendName accepts only a name of frontendNames, as written. It does not change the case or trim spaces.
func parseFrontendName(value string) (string, error) {
	for _, name := range frontendNames {
		if value == name {
			return name, nil
		}
	}
	quoted := make([]string, len(frontendNames))
	for index, name := range frontendNames {
		quoted[index] = fmt.Sprintf("%q", name)
	}
	return "", fmt.Errorf("expected one of %s, got %q", strings.Join(quoted, ", "), value)
}

// openFrontend returns the file system of the named browser interface.
func openFrontend(name string) (fs.FS, error) {
	public, err := fs.Sub(embeddedPublic, "public")
	if err != nil {
		return nil, fmt.Errorf("open embedded frontend: %w", err)
	}
	switch name {
	case frontendDefault:
		return public, nil
	case frontendPortal:
		own, err := fs.Sub(embeddedFrontends, "frontends/"+name)
		if err != nil {
			return nil, fmt.Errorf("open embedded frontend %q: %w", name, err)
		}
		if _, err := fs.Stat(own, sharedFrontendPrefix); err == nil {
			return nil, fmt.Errorf("embedded frontend %q must not contain %s", name, sharedFrontendPrefix)
		}
		return &vendorOverlayFS{own: own, shared: public}, nil
	}
	return nil, fmt.Errorf("unknown frontend %q", name)
}

// vendorOverlayFS is an alternative frontend tree plus the shared vendor directory of the default tree. A path under
// sharedFrontendPrefix comes from the default tree. All other paths come from the alternative tree only, so the
// stylesheets and scripts of the default interface are not visible through it. The directories on the path to the
// shared prefix ("." and "assets") list the entries of the two trees.
type vendorOverlayFS struct {
	own    fs.FS
	shared fs.FS
}

var (
	_ fs.ReadDirFS = (*vendorOverlayFS)(nil)
	_ fs.StatFS    = (*vendorOverlayFS)(nil)
)

func isSharedFrontendPath(name string) bool {
	return name == sharedFrontendPrefix || strings.HasPrefix(name, sharedFrontendPrefix+"/")
}

// sharedChild returns the name of the entry that dir must show for the shared prefix, when dir is an ancestor of it.
func sharedChild(dir string) (string, bool) {
	rest := sharedFrontendPrefix
	if dir != "." {
		if !strings.HasPrefix(sharedFrontendPrefix, dir+"/") {
			return "", false
		}
		rest = strings.TrimPrefix(sharedFrontendPrefix, dir+"/")
	}
	child, _, _ := strings.Cut(rest, "/")
	return child, true
}

func (o *vendorOverlayFS) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	if isSharedFrontendPath(name) {
		return o.shared.Open(name)
	}
	file, err := o.own.Open(name)
	if err != nil {
		return nil, err
	}
	if _, ancestor := sharedChild(name); !ancestor {
		return file, nil
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	if !info.IsDir() {
		return file, nil
	}
	entries, err := o.ReadDir(name)
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	return &overlayDir{File: file, info: info, entries: entries}, nil
}

func (o *vendorOverlayFS) Stat(name string) (fs.FileInfo, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "stat", Path: name, Err: fs.ErrInvalid}
	}
	if isSharedFrontendPath(name) {
		return fs.Stat(o.shared, name)
	}
	return fs.Stat(o.own, name)
}

func (o *vendorOverlayFS) ReadDir(name string) ([]fs.DirEntry, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrInvalid}
	}
	if isSharedFrontendPath(name) {
		return fs.ReadDir(o.shared, name)
	}
	entries, err := fs.ReadDir(o.own, name)
	if err != nil {
		return nil, err
	}
	child, ancestor := sharedChild(name)
	if !ancestor {
		return entries, nil
	}
	for _, entry := range entries {
		if entry.Name() == child {
			return entries, nil
		}
	}
	info, err := fs.Stat(o.shared, path.Join(name, child))
	if err != nil {
		return nil, fmt.Errorf("open shared frontend directory %q: %w", path.Join(name, child), err)
	}
	entries = append(entries, fs.FileInfoToDirEntry(info))
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}

// overlayDir is an open directory of the alternative tree that also lists the shared entry.
type overlayDir struct {
	fs.File
	info    fs.FileInfo
	entries []fs.DirEntry
	offset  int
}

func (d *overlayDir) Stat() (fs.FileInfo, error) { return d.info, nil }

func (d *overlayDir) Read([]byte) (int, error) {
	return 0, &fs.PathError{Op: "read", Path: d.info.Name(), Err: errors.New("is a directory")}
}

func (d *overlayDir) ReadDir(count int) ([]fs.DirEntry, error) {
	remaining := d.entries[d.offset:]
	if count <= 0 {
		d.offset = len(d.entries)
		return remaining, nil
	}
	if len(remaining) == 0 {
		return nil, io.EOF
	}
	if count > len(remaining) {
		count = len(remaining)
	}
	d.offset += count
	return remaining[:count], nil
}
