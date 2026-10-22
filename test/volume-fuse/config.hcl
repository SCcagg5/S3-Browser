# The Stowr of the FUSE test: one volume on the FUSE mount of SeaweedFS (scripts/entrypoint.sh). The tests of
# test/volume-fuse/smoke.js use it.
server {
  frontend = "portal"
  listen   = ":8080"
}

volume "sw" {
  name           = "SeaweedFS mount"
  path           = "/mnt/sw/stowr"
  max_scan_pages = 15
}

access {
  mode = "open"
}
