package drawdown

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/warp"
)

// MaxFiles is how many files the detail view lists, across all steps and
// both runs compared: as many as loom records, but a store may hold
// records written otherwise, so the view bounds them itself.
const MaxFiles = loom.MaxRecordedFiles

// stepFile is one file a step left, as its record holds it, compared with
// the previous run of the same program.
type stepFile struct {
	Path   string  `json:"path"`
	Size   int64   `json:"size"`
	Blob   warp.ID `json:"blob,omitempty"`   // this run's content; none if deleted
	Before warp.ID `json:"before,omitempty"` // the previous run's, if it had this file
	// Status is "added" (not in the previous run, or there is none),
	// "changed", "same" or "deleted" (only in the previous run).
	Status string `json:"status"`
}

// recordFiles reads every file under a record's files/<node>/ as node ->
// path -> file, with one git process for the listing (warp's Files).
func (s *Server) recordFiles(ctx context.Context, tree warp.ID) (map[string]map[string]warp.File, error) {
	out := map[string]map[string]warp.File{}
	root, ok, err := s.subtree(ctx, tree, loom.FilesDir)
	if err != nil || !ok {
		return out, err
	}
	files, err := s.Store.Files(ctx, root)
	if err != nil {
		return nil, err
	}
	for _, f := range files {
		node, path, ok := strings.Cut(f.Path, "/")
		if !ok {
			continue // a blob directly in files/, not under a node
		}
		if out[node] == nil {
			out[node] = map[string]warp.File{}
		}
		out[node][path] = f
	}
	return out, nil
}

// subtree is tree's entry name, if it is a tree.
func (s *Server) subtree(ctx context.Context, tree warp.ID, name string) (warp.ID, bool, error) {
	es, err := s.Store.Tree(ctx, tree)
	if err != nil {
		return "", false, err
	}
	for _, e := range es {
		if e.Name == name && e.Kind == warp.KindTree {
			return e.ID, true, nil
		}
	}
	return "", false, nil
}

// stepFiles compares a record's files with the previous run's (prev may be
// ""), in node then path order: every file of both runs is compared, then
// the first MaxFiles in that order are listed (more reports the rest).
func (s *Server) stepFiles(ctx context.Context, tree, prev warp.ID) (map[string][]stepFile, bool, error) {
	now, err := s.recordFiles(ctx, tree)
	if err != nil {
		return nil, false, err
	}
	before := map[string]map[string]warp.File{}
	if prev != "" {
		ptree, _, err := s.Store.Parents(ctx, prev)
		if err != nil {
			return nil, false, err
		}
		if before, err = s.recordFiles(ctx, ptree); err != nil {
			return nil, false, err
		}
	}
	type keyed struct {
		node string
		f    stepFile
	}
	var all []keyed
	for node, files := range now {
		for path, f := range files {
			sf := stepFile{Path: path, Size: f.Size, Blob: f.ID, Status: "added"}
			if b, ok := before[node][path]; ok {
				sf.Before, sf.Status = b.ID, map[bool]string{true: "same", false: "changed"}[b.ID == f.ID]
			}
			all = append(all, keyed{node, sf})
		}
	}
	for node, files := range before {
		for path, b := range files {
			if _, ok := now[node][path]; !ok {
				all = append(all, keyed{node, stepFile{Path: path, Size: b.Size, Before: b.ID, Status: "deleted"}})
			}
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].node != all[j].node {
			return all[i].node < all[j].node
		}
		return all[i].f.Path < all[j].f.Path
	})
	more := len(all) > MaxFiles
	if more {
		all = all[:MaxFiles]
	}
	res := map[string][]stepFile{}
	for _, k := range all {
		res[k.node] = append(res[k.node], k.f)
	}
	return res, more, nil
}

// MaxDiffBlob is the largest file /api/blobdiff diffs: bigger ones are
// for git itself, not a browser.
const MaxDiffBlob = 1 << 20

// blobDiff is one file's change between two records: GET
// /api/blobdiff/{from}/{to}, both blob IDs. Like /api/diff, it serves
// any object in the store by its full ID.
func (s *Server) blobDiff(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	from, to := warp.ID(r.PathValue("from")), warp.ID(r.PathValue("to"))
	var err error
	for _, id := range []warp.ID{from, to} {
		var n int64
		if n, err = s.Store.BlobSize(ctx, id); err != nil {
			break
		}
		if n > MaxDiffBlob {
			writeJSON(w, http.StatusRequestEntityTooLarge, apiError{Error: fmt.Sprintf("a file of %d bytes is too large to diff here; use git diff %s %s", n, from, to)})
			return
		}
	}
	var d []byte
	if err == nil {
		d, err = s.Store.DiffBlobs(ctx, from, to)
	}
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, warp.ErrInvalid) || errors.Is(err, warp.ErrNotFound) {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, apiError{Error: err.Error()})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(d)
}
