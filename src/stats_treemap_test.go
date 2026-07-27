package main

import "testing"

func TestBuildStatsTreemapGroupsSmallEntriesAndContractsSingleChildFolders(t *testing.T) {
	stats := &statsResponse{
		Prefix:     "Home/",
		Count:      5,
		TotalBytes: 10_000,
		ByFolder: map[string]aggregate{
			"prometheus/":          {Count: 2, Bytes: 9_000},
			"prometheus/binaries/": {Count: 2, Bytes: 9_000},
			"tiny/":                {Count: 2, Bytes: 90},
		},
		Largest: []statsEntry{
			{Path: "Home/prometheus/binaries/a.tgz", Bytes: 5_000, Type: "archive"},
			{Path: "Home/prometheus/binaries/b.tgz", Bytes: 4_000, Type: "archive"},
			{Path: "Home/tiny/x.bin", Bytes: 50, Type: "other"},
			{Path: "Home/tiny/y.bin", Bytes: 40, Type: "other"},
		},
	}

	threshold, tree := buildStatsTreemap(stats)
	if threshold != 100 {
		t.Fatalf("threshold = %d, want 100", threshold)
	}
	if tree == nil {
		t.Fatal("expected a treemap")
	}
	if len(tree.Children) != 2 {
		t.Fatalf("root children = %d, want 2: %#v", len(tree.Children), tree.Children)
	}

	var prometheus *statsTreemapNode
	var others *statsTreemapNode
	for index := range tree.Children {
		child := &tree.Children[index]
		switch child.Kind {
		case "folder":
			prometheus = child
		case "other":
			others = child
		}
	}
	if prometheus == nil || prometheus.Name != "prometheus" {
		t.Fatalf("missing prometheus node: %#v", tree.Children)
	}
	if len(prometheus.Children) != 2 {
		t.Fatalf("prometheus children = %d, want 2", len(prometheus.Children))
	}
	for _, child := range prometheus.Children {
		if child.Name == "binaries" {
			t.Fatal("single-child binaries folder must be contracted by the backend")
		}
		if child.Kind != "file" {
			t.Fatalf("contracted child kind = %q, want file", child.Kind)
		}
	}
	if others == nil {
		t.Fatalf("missing Others node: %#v", tree.Children)
	}
	if others.Bytes != 1_000 || others.Count != 3 {
		t.Fatalf("Others = %d bytes / %d objects, want 1000 / 3", others.Bytes, others.Count)
	}
}

func TestBuildStatsTreemapSuppressesSoleOthersNode(t *testing.T) {
	stats := &statsResponse{
		Prefix:     "only/",
		Count:      3,
		TotalBytes: 300,
		ByFolder:   map[string]aggregate{},
	}
	_, tree := buildStatsTreemap(stats)
	if tree == nil {
		t.Fatal("expected a treemap")
	}
	if len(tree.Children) != 0 {
		t.Fatalf("sole Others child must be removed, got %#v", tree.Children)
	}
	if tree.Bytes != 300 || tree.Count != 3 {
		t.Fatalf("root totals changed: %d bytes / %d objects", tree.Bytes, tree.Count)
	}
}

func TestStatsTreemapThresholdKeepsExactOnePercent(t *testing.T) {
	if got := statsTreemapThreshold(1_000); got != 10 {
		t.Fatalf("threshold = %d, want 10", got)
	}
	if got := statsTreemapThreshold(1_001); got != 11 {
		t.Fatalf("threshold = %d, want 11", got)
	}
}
