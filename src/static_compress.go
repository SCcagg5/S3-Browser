package main

import (
	"net/http"
	"strconv"
	"strings"
)

// compressibleContentType reports whether an embedded frontend response is
// text that benefits from gzip. Object bytes never reach this path (see static_assets.go).
func compressibleContentType(contentType string) bool {
	base := strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	switch base {
	case "text/html", "text/css", "text/javascript", "application/javascript", "application/json", "image/svg+xml":
		return true
	}
	return false
}

// acceptsGzip reports whether the client allows gzip, honouring "gzip;q=0".
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		fields := strings.Split(part, ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		for _, param := range fields[1:] {
			name, value, _ := strings.Cut(strings.TrimSpace(param), "=")
			if strings.EqualFold(name, "q") {
				if weight, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil && weight <= 0 {
					return false
				}
			}
		}
		return true
	}
	return false
}
