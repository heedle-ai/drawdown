package drawdown

import (
	"context"
	"errors"
	"net/http"
	"sort"

	"github.com/heedle-ai/loom"
	"github.com/heedle-ai/warp"
)

// MaxFiles is how many recorded files the detail view lists: as many as
// loom records, but a store may hold records written otherwise, so the
// view bounds them itself.
const MaxFiles = loom.MaxRecordedFiles

// stepFile is one file a step left, as its record holds it, compared with
// the previous run of the same program.
type stepFile struct {
	Path   string  `json:"path"`
	Size   int     `json:"size"`
	Blob   warp.ID `json:"blob,omitempty"`   // this run's content; none if deleted
	Before warp.ID `json:"before,omitempty"` // the previous run's, if it had this file
	// Status is "added" (not in the previous run, or there is none),
	// "changed", "same" or "deleted" (only in the previous run).
	Status string `json:"status"`
}

// recordFiles reads a record's files/<node>/ trees as node -> path -> blob,
// with at most MaxFiles files in all (more reports true).
func (s *Server) recordFiles(ctx context.Context, tree warp.ID) (map[string]map[string]warp.ID, bool, error) {
	out := map[string]map[string]warp.ID{}
	root, ok, err := s.subtree(ctx, tree, loom.FilesDir)
	if err != nil || !ok {
		return out, false, err
	}
	nodes, err := s.Store.Tree(ctx, root)
	if err != nil {
		return nil, false, err
	}
	n, more := 0, false
	var walk func(node string, dir warp.ID, prefix string) error
	walk = func(node string, dir warp.ID, prefix string) error {
		es, err := s.Store.Tree(ctx, dir)
		if err != nil {
			return err
		}
		for _, e := range es {
			if n >= MaxFiles {
				more = true
				return nil
			}
			switch e.Kind {
			case warp.KindBlob:
				out[node][prefix+e.Name] = e.ID
				n++
			case warp.KindTree:
				if err := walk(node, e.ID, prefix+e.Name+"/"); err != nil {
					return err
				}
			}
		}
		return nil
	}
	for _, e := range nodes {
		if e.Kind != warp.KindTree {
			continue
		}
		out[e.Name] = map[string]warp.ID{}
		if err := walk(e.Name, e.ID, ""); err != nil {
			return nil, false, err
		}
	}
	return out, more, nil
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
// ""), node by node, in path order. Sizes are read with one git process.
func (s *Server) stepFiles(ctx context.Context, tree, prev warp.ID) (map[string][]stepFile, bool, error) {
	now, more, err := s.recordFiles(ctx, tree)
	if err != nil {
		return nil, false, err
	}
	before := map[string]map[string]warp.ID{}
	if prev != "" {
		ptree, _, err := s.Store.Parents(ctx, prev)
		if err != nil {
			return nil, false, err
		}
		var pmore bool
		if before, pmore, err = s.recordFiles(ctx, ptree); err != nil {
			return nil, false, err
		}
		more = more || pmore
	}
	res := map[string][]stepFile{}
	var ids []warp.ID
	for node, files := range now {
		for path, id := range files {
			f := stepFile{Path: path, Blob: id, Status: "added"}
			if b, ok := before[node][path]; ok {
				f.Before, f.Status = b, map[bool]string{true: "same", false: "changed"}[b == id]
			}
			res[node] = append(res[node], f)
			ids = append(ids, id)
		}
	}
	for node, files := range before {
		for path, id := range files {
			if _, ok := now[node][path]; !ok {
				res[node] = append(res[node], stepFile{Path: path, Before: id, Status: "deleted"})
				ids = append(ids, id)
			}
		}
	}
	data, err := s.Store.Blobs(ctx, ids)
	if err != nil {
		return nil, false, err
	}
	size := map[warp.ID]int{}
	for i, id := range ids {
		size[id] = len(data[i])
	}
	for node, fs := range res {
		for i := range fs {
			fs[i].Size = size[fs[i].Blob]
			if fs[i].Blob == "" {
				fs[i].Size = size[fs[i].Before]
			}
		}
		sort.Slice(fs, func(i, j int) bool { return fs[i].Path < fs[j].Path })
		res[node] = fs
	}
	return res, more, nil
}

// blobDiff is one file's change between two records: GET
// /api/blobdiff/{from}/{to}, both blob IDs.
func (s *Server) blobDiff(w http.ResponseWriter, r *http.Request) {
	d, err := s.Store.DiffBlobs(r.Context(), warp.ID(r.PathValue("from")), warp.ID(r.PathValue("to")))
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
