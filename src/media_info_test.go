package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func isoBox(boxType string, payload []byte) []byte {
	box := make([]byte, 8+len(payload))
	binary.BigEndian.PutUint32(box[:4], uint32(len(box)))
	copy(box[4:8], []byte(boxType))
	copy(box[8:], payload)
	return box
}

func testMP4MetadataObject() []byte {
	mvhd := make([]byte, 20)
	binary.BigEndian.PutUint32(mvhd[12:16], 1000)
	binary.BigEndian.PutUint32(mvhd[16:20], 12500)
	tkhd := make([]byte, 84)
	binary.BigEndian.PutUint32(tkhd[len(tkhd)-8:len(tkhd)-4], 1920<<16)
	binary.BigEndian.PutUint32(tkhd[len(tkhd)-4:], 1080<<16)

	hdlrVideo := make([]byte, 12)
	copy(hdlrVideo[8:12], []byte("vide"))
	videoEntry := make([]byte, 36)
	binary.BigEndian.PutUint32(videoEntry[:4], uint32(len(videoEntry)))
	copy(videoEntry[4:8], []byte("avc1"))
	binary.BigEndian.PutUint16(videoEntry[32:34], 1920)
	binary.BigEndian.PutUint16(videoEntry[34:36], 1080)
	videoSTSD := make([]byte, 8)
	binary.BigEndian.PutUint32(videoSTSD[4:8], 1)
	videoSTSD = append(videoSTSD, videoEntry...)
	videoMDIA := isoBox("mdia", append(isoBox("hdlr", hdlrVideo), isoBox("minf", isoBox("stbl", isoBox("stsd", videoSTSD)))...))
	videoTRAK := isoBox("trak", append(isoBox("tkhd", tkhd), videoMDIA...))

	hdlrAudio := make([]byte, 12)
	copy(hdlrAudio[8:12], []byte("soun"))
	audioEntry := make([]byte, 36)
	binary.BigEndian.PutUint32(audioEntry[:4], uint32(len(audioEntry)))
	copy(audioEntry[4:8], []byte("mp4a"))
	binary.BigEndian.PutUint16(audioEntry[24:26], 2)
	binary.BigEndian.PutUint32(audioEntry[32:36], 48000<<16)
	audioSTSD := make([]byte, 8)
	binary.BigEndian.PutUint32(audioSTSD[4:8], 1)
	audioSTSD = append(audioSTSD, audioEntry...)
	audioMDIA := isoBox("mdia", append(isoBox("hdlr", hdlrAudio), isoBox("minf", isoBox("stbl", isoBox("stsd", audioSTSD)))...))
	audioTRAK := isoBox("trak", audioMDIA)

	moovPayload := append(isoBox("mvhd", mvhd), videoTRAK...)
	moovPayload = append(moovPayload, audioTRAK...)
	moov := isoBox("moov", moovPayload)
	ftyp := isoBox("ftyp", []byte("isom\x00\x00\x00\x00isommp42"))
	mdat := isoBox("mdat", make([]byte, 256<<10))
	data := append(ftyp, mdat...)
	return append(data, moov...)
}

func syntheticPNG(width, height int) []byte {
	data := append([]byte{137, 80, 78, 71, 13, 10, 26, 10}, make([]byte, 25)...)
	binary.BigEndian.PutUint32(data[8:12], 13)
	copy(data[12:16], []byte("IHDR"))
	binary.BigEndian.PutUint32(data[16:20], uint32(width))
	binary.BigEndian.PutUint32(data[20:24], uint32(height))
	data[24] = 8
	data[25] = 2
	data = append(data, 0, 0, 0, 0)
	data = append(data, 0, 0, 0, 0)
	data = append(data, []byte("IEND")...)
	data = append(data, 0, 0, 0, 0)
	return data
}

func requestMediaInfo(t *testing.T, app *application, key string) mediaInfoResponse {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/media-info?instance=rw&key="+key, nil)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response mediaInfoResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func backendReadCounts(backend *memoryBackend) (gets, heads int, ranges []string) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.getCount, backend.headCount, append([]string(nil), backend.getRanges...)
}

func TestMediaInfoReadsOnlyPNGHeaderAndNoHEAD(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/image.png"] = memoryObject{data: syntheticPNG(640, 480), contentType: "image/png", modified: time.Now().UTC()}
	backend.mu.Unlock()

	response := requestMediaInfo(t, app, "image.png")
	if response.Width != 640 || response.Height != 480 || response.Container != "PNG" {
		t.Fatalf("response = %+v", response)
	}
	if response.Headers["x-amz-meta-test"] != "visible" {
		t.Fatalf("storage metadata = %#v", response.Headers)
	}
	gets, heads, ranges := backendReadCounts(backend)
	if gets != 1 || heads != 0 {
		t.Fatalf("GETs = %d, HEADs = %d, ranges = %#v", gets, heads, ranges)
	}
	if len(ranges) != 1 || ranges[0] != "bytes=0-65535" {
		// The PNG parser asks for its fixed header and then reuses the same
		// request-local span while walking IHDR/IEND. The in-memory backend clamps
		// the response to the object size.
		t.Fatalf("ranges = %#v", ranges)
	}
}

func TestMediaInfoReadsTrailingMP4MetadataWithoutReadingMediaPayload(t *testing.T) {
	app, _, backend := testApplication(t)
	data := testMP4MetadataObject()
	backend.mu.Lock()
	backend.objects["tenant/movie.1080p.mp4"] = memoryObject{data: data, contentType: "video/mp4", modified: time.Now().UTC()}
	backend.mu.Unlock()

	response := requestMediaInfo(t, app, "movie.1080p.mp4")
	if response.Width != 1920 || response.Height != 1080 {
		t.Fatalf("resolution = %dx%d", response.Width, response.Height)
	}
	if response.DurationSeconds != 12.5 {
		t.Fatalf("duration = %v", response.DurationSeconds)
	}
	if strings.Join(response.Codecs, ",") != "avc1,mp4a" {
		t.Fatalf("codecs = %#v", response.Codecs)
	}
	if len(response.Tracks) != 2 || response.Tracks[0].Type != "video" || response.Tracks[1].Type != "audio" {
		t.Fatalf("tracks = %#v", response.Tracks)
	}
	gets, heads, ranges := backendReadCounts(backend)
	if heads != 0 || gets != 2 {
		t.Fatalf("GETs = %d, HEADs = %d, ranges = %#v", gets, heads, ranges)
	}
	if len(ranges) != 2 || ranges[0] != "bytes=0-65535" || !strings.HasPrefix(ranges[1], "bytes=262") {
		t.Fatalf("ranges = %#v", ranges)
	}
	for _, value := range ranges {
		if value == "" {
			t.Fatalf("unexpected full-object GET: %#v", ranges)
		}
	}
}

func syntheticJPEGWithLargeHeader(width, height int) []byte {
	data := []byte{0xff, 0xd8}
	for index := 0; index < 2; index++ {
		segment := make([]byte, 65533)
		data = append(data, 0xff, byte(0xe2+index), 0xff, 0xff)
		data = append(data, segment...)
	}
	sof := []byte{0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00}
	binary.BigEndian.PutUint16(sof[5:7], uint16(height))
	binary.BigEndian.PutUint16(sof[7:9], uint16(width))
	data = append(data, sof...)
	return append(data, 0xff, 0xda, 0x00, 0x02)
}

func TestMediaInfoReadsCompleteJPEGHeaderBeyond64KiB(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/large-header.jpg"] = memoryObject{data: syntheticJPEGWithLargeHeader(8256, 5504), contentType: "image/jpeg", modified: time.Now().UTC()}
	backend.mu.Unlock()

	response := requestMediaInfo(t, app, "large-header.jpg")
	if response.Width != 8256 || response.Height != 5504 {
		t.Fatalf("resolution = %dx%d", response.Width, response.Height)
	}
	gets, heads, ranges := backendReadCounts(backend)
	if heads != 0 || gets != 2 {
		t.Fatalf("GETs = %d, HEADs = %d, ranges = %#v", gets, heads, ranges)
	}
	if len(ranges) != 2 || ranges[0] != "bytes=0-65535" || !strings.HasPrefix(ranges[1], "bytes=65536-") {
		t.Fatalf("ranges = %#v", ranges)
	}
}

func TestMediaInfoHasNoCrossRequestCache(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/image.png"] = memoryObject{data: syntheticPNG(320, 200), contentType: "image/png", modified: time.Now().UTC()}
	backend.mu.Unlock()

	_ = requestMediaInfo(t, app, "image.png")
	firstGets, firstHeads, _ := backendReadCounts(backend)
	_ = requestMediaInfo(t, app, "image.png")
	secondGets, secondHeads, _ := backendReadCounts(backend)
	if firstGets != 1 || firstHeads != 0 || secondGets != 2 || secondHeads != 0 {
		t.Fatalf("first GET/HEAD = %d/%d, second = %d/%d", firstGets, firstHeads, secondGets, secondHeads)
	}
}

func TestMediaInfoUsesListedMIMEHintForExtensionlessImage(t *testing.T) {
	app, _, backend := testApplication(t)
	data := syntheticPNG(2048, 1365)
	backend.mu.Lock()
	backend.objects["tenant/extensionless"] = memoryObject{data: data, contentType: "image/png", modified: time.Now().UTC()}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/media-info?instance=rw&key=extensionless&mime=image%2Fpng&size="+strconv.Itoa(len(data)), nil)
	app.routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response mediaInfoResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Width != 2048 || response.Height != 1365 {
		t.Fatalf("resolution = %dx%d", response.Width, response.Height)
	}
	gets, heads, ranges := backendReadCounts(backend)
	if gets != 1 || heads != 0 || len(ranges) != 1 || ranges[0] == "" {
		t.Fatalf("GETs = %d, HEADs = %d, ranges = %#v", gets, heads, ranges)
	}
}

func TestTextDetailsStreamsObjectOnceAndCountsLines(t *testing.T) {
	app, _, backend := testApplication(t)
	backend.mu.Lock()
	backend.objects["tenant/file.txt"] = memoryObject{data: []byte("hello\nworld"), contentType: "text/plain", modified: time.Now().UTC()}
	backend.mu.Unlock()

	response := requestMediaInfo(t, app, "file.txt")
	if response.Size != 11 || response.MIME != "text/plain" || response.Properties["Lines"] != "2" {
		t.Fatalf("response = %+v", response)
	}
	gets, heads, ranges := backendReadCounts(backend)
	if gets != 1 || heads != 0 || len(ranges) != 1 || ranges[0] != "" {
		t.Fatalf("GETs = %d, HEADs = %d, ranges = %#v", gets, heads, ranges)
	}
}

func syntheticJPEG(width, height int) []byte {
	data := []byte{0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9}
	binary.BigEndian.PutUint16(data[7:9], uint16(height))
	binary.BigEndian.PutUint16(data[9:11], uint16(width))
	return data
}

func syntheticRAF(width, height int) []byte {
	preview := syntheticJPEG(width, height)
	data := make([]byte, 128+len(preview))
	copy(data, []byte("FUJIFILMCCD-RAW "))
	binary.BigEndian.PutUint32(data[84:88], 128)
	binary.BigEndian.PutUint32(data[88:92], uint32(len(preview)))
	copy(data[128:], preview)
	return data
}

func TestRAFUsesEmbeddedJPEGForBoundedMetadataAndPreview(t *testing.T) {
	app, _, backend := testApplication(t)
	data := syntheticRAF(6240, 4160)
	backend.mu.Lock()
	backend.objects["tenant/photo.raf"] = memoryObject{data: data, contentType: "image/x-fuji-raf", modified: time.Now().UTC()}
	backend.mu.Unlock()

	infoRecorder := httptest.NewRecorder()
	app.routes().ServeHTTP(infoRecorder, httptest.NewRequest(http.MethodGet, "/api/media-info?instance=rw&key=photo.raf", nil))
	if infoRecorder.Code != http.StatusOK {
		t.Fatalf("metadata status = %d, body = %s", infoRecorder.Code, infoRecorder.Body.String())
	}
	var info mediaInfoResponse
	if err := json.Unmarshal(infoRecorder.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.Width != 6240 || info.Height != 4160 || info.Container != "RAF" {
		t.Fatalf("metadata = %+v", info)
	}
	previewRecorder := httptest.NewRecorder()
	app.routes().ServeHTTP(previewRecorder, httptest.NewRequest(http.MethodGet, "/api/image-preview?instance=rw&key=photo.raf", nil))
	if previewRecorder.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body = %s", previewRecorder.Code, previewRecorder.Body.String())
	}
	if previewRecorder.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("content type = %q", previewRecorder.Header().Get("Content-Type"))
	}
	if !strings.HasPrefix(previewRecorder.Body.String(), string([]byte{0xff, 0xd8})) {
		t.Fatalf("preview is not JPEG: %x", previewRecorder.Body.Bytes())
	}
}

func TestImagePreviewRejectsFormatsWithoutEmbeddedPreview(t *testing.T) {
	app, _, backend := testApplication(t)
	data := append([]byte("P6\n2 1\n255\n"), []byte{255, 0, 0, 0, 255, 0}...)
	backend.mu.Lock()
	backend.objects["tenant/two-pixels.ppm"] = memoryObject{data: data, contentType: "image/x-portable-pixmap", modified: time.Now().UTC()}
	backend.mu.Unlock()

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/image-preview?instance=rw&key=two-pixels.ppm", nil))
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "embedded JPEG preview") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func putTIFFEntry(data []byte, ifdOffset, index int, tag, typeID uint16, count uint32, value uint32) {
	entry := ifdOffset + 2 + index*12
	binary.LittleEndian.PutUint16(data[entry:entry+2], tag)
	binary.LittleEndian.PutUint16(data[entry+2:entry+4], typeID)
	binary.LittleEndian.PutUint32(data[entry+4:entry+8], count)
	binary.LittleEndian.PutUint32(data[entry+8:entry+12], value)
}

func syntheticTIFFWithEXIFAndGPS() []byte {
	data := make([]byte, 520)
	copy(data[:2], []byte("II"))
	binary.LittleEndian.PutUint16(data[2:4], 42)
	binary.LittleEndian.PutUint32(data[4:8], 8)

	const (
		ifd0Offset      = 8
		exifOffset      = 128
		gpsOffset       = 256
		makeOffset      = 96
		modelOffset     = 104
		dateOffset      = 352
		lensOffset      = 384
		exposureOffset  = 416
		apertureOffset  = 424
		focalOffset     = 432
		latitudeOffset  = 448
		longitudeOffset = 472
		altitudeOffset  = 496
	)

	binary.LittleEndian.PutUint16(data[ifd0Offset:ifd0Offset+2], 6)
	putTIFFEntry(data, ifd0Offset, 0, 0x0100, 4, 1, 4000)
	putTIFFEntry(data, ifd0Offset, 1, 0x0101, 4, 1, 3000)
	putTIFFEntry(data, ifd0Offset, 2, 0x010f, 2, 6, makeOffset)
	putTIFFEntry(data, ifd0Offset, 3, 0x0110, 2, 7, modelOffset)
	putTIFFEntry(data, ifd0Offset, 4, 0x8769, 4, 1, exifOffset)
	putTIFFEntry(data, ifd0Offset, 5, 0x8825, 4, 1, gpsOffset)
	copy(data[makeOffset:], []byte("Canon\x00"))
	copy(data[modelOffset:], []byte("EOS R5\x00"))

	binary.LittleEndian.PutUint16(data[exifOffset:exifOffset+2], 8)
	putTIFFEntry(data, exifOffset, 0, 0x9003, 2, 20, dateOffset)
	putTIFFEntry(data, exifOffset, 1, 0x8827, 3, 1, 800)
	putTIFFEntry(data, exifOffset, 2, 0x829a, 5, 1, exposureOffset)
	putTIFFEntry(data, exifOffset, 3, 0x829d, 5, 1, apertureOffset)
	putTIFFEntry(data, exifOffset, 4, 0x920a, 5, 1, focalOffset)
	putTIFFEntry(data, exifOffset, 5, 0xa434, 2, 12, lensOffset)
	putTIFFEntry(data, exifOffset, 6, 0xa002, 4, 1, 4000)
	putTIFFEntry(data, exifOffset, 7, 0xa003, 4, 1, 3000)
	copy(data[dateOffset:], []byte("2026:07:23 10:11:12\x00"))
	copy(data[lensOffset:], []byte("RF50mm F1.2\x00"))
	binary.LittleEndian.PutUint32(data[exposureOffset:exposureOffset+4], 1)
	binary.LittleEndian.PutUint32(data[exposureOffset+4:exposureOffset+8], 250)
	binary.LittleEndian.PutUint32(data[apertureOffset:apertureOffset+4], 28)
	binary.LittleEndian.PutUint32(data[apertureOffset+4:apertureOffset+8], 10)
	binary.LittleEndian.PutUint32(data[focalOffset:focalOffset+4], 50)
	binary.LittleEndian.PutUint32(data[focalOffset+4:focalOffset+8], 1)

	binary.LittleEndian.PutUint16(data[gpsOffset:gpsOffset+2], 6)
	putTIFFEntry(data, gpsOffset, 0, 0x0001, 2, 2, uint32('N'))
	putTIFFEntry(data, gpsOffset, 1, 0x0002, 5, 3, latitudeOffset)
	putTIFFEntry(data, gpsOffset, 2, 0x0003, 2, 2, uint32('E'))
	putTIFFEntry(data, gpsOffset, 3, 0x0004, 5, 3, longitudeOffset)
	putTIFFEntry(data, gpsOffset, 4, 0x0005, 1, 1, 0)
	putTIFFEntry(data, gpsOffset, 5, 0x0006, 5, 1, altitudeOffset)
	for index, value := range [][2]uint32{{48, 1}, {51, 1}, {30, 1}} {
		offset := latitudeOffset + index*8
		binary.LittleEndian.PutUint32(data[offset:offset+4], value[0])
		binary.LittleEndian.PutUint32(data[offset+4:offset+8], value[1])
	}
	for index, value := range [][2]uint32{{2, 1}, {20, 1}, {0, 1}} {
		offset := longitudeOffset + index*8
		binary.LittleEndian.PutUint32(data[offset:offset+4], value[0])
		binary.LittleEndian.PutUint32(data[offset+4:offset+8], value[1])
	}
	binary.LittleEndian.PutUint32(data[altitudeOffset:altitudeOffset+4], 35)
	binary.LittleEndian.PutUint32(data[altitudeOffset+4:altitudeOffset+8], 1)
	return data
}

func TestBoundedEXIFMetadataIncludesCameraAndGPS(t *testing.T) {
	metadata := parseBoundedFileMetadata(syntheticTIFFWithEXIFAndGPS(), "tiff", "image/tiff", 520)
	if metadata.Width != 4000 || metadata.Height != 3000 {
		t.Fatalf("resolution = %dx%d", metadata.Width, metadata.Height)
	}
	want := map[string]string{
		"Camera make":  "Canon",
		"Camera model": "EOS R5",
		"Captured":     "2026:07:23 10:11:12",
		"Lens":         "RF50mm F1.2",
		"ISO":          "800",
		"Exposure":     "1/250 s",
		"Aperture":     "f/2.8",
		"Focal length": "50.0 mm",
		"GPS":          "48.858333, 2.333333",
		"GPS altitude": "35.0 m",
	}
	for key, expected := range want {
		if actual := metadata.Properties[key]; actual != expected {
			t.Errorf("%s = %q, want %q", key, actual, expected)
		}
	}
}

func syntheticID3MP3() []byte {
	frame := func(id, value string) []byte {
		payload := append([]byte{3}, []byte(value)...)
		out := make([]byte, 10+len(payload))
		copy(out[:4], []byte(id))
		binary.BigEndian.PutUint32(out[4:8], uint32(len(payload)))
		copy(out[10:], payload)
		return out
	}
	frames := append(frame("TIT2", "Example song"), frame("TPE1", "Example artist")...)
	header := make([]byte, 10)
	copy(header[:3], []byte("ID3"))
	header[3] = 3
	size := len(frames)
	header[6] = byte((size >> 21) & 0x7f)
	header[7] = byte((size >> 14) & 0x7f)
	header[8] = byte((size >> 7) & 0x7f)
	header[9] = byte(size & 0x7f)
	data := append(header, frames...)
	return append(data, []byte{0xff, 0xfb, 0x90, 0x00}...)
}

func TestBoundedMP3MetadataIncludesTagsAndAudioProperties(t *testing.T) {
	metadata := parseBoundedFileMetadata(syntheticID3MP3(), "mp3", "audio/mpeg", 128000)
	if metadata.Properties["Title"] != "Example song" || metadata.Properties["Artist"] != "Example artist" {
		t.Fatalf("tags = %#v", metadata.Properties)
	}
	if metadata.Properties["Bit rate"] != "128 kb/s" || metadata.Properties["Sample rate"] != "44.1 kHz" || metadata.Properties["Channels"] != "2" {
		t.Fatalf("audio properties = %#v", metadata.Properties)
	}
	if metadata.DurationSeconds != 8 {
		t.Fatalf("duration = %v", metadata.DurationSeconds)
	}
}

func syntheticClassicTIFFVariant(magic uint16, width, height uint32) []byte {
	data := make([]byte, 8+2+2*12+4)
	copy(data[:2], []byte("II"))
	binary.LittleEndian.PutUint16(data[2:4], magic)
	binary.LittleEndian.PutUint32(data[4:8], 8)
	binary.LittleEndian.PutUint16(data[8:10], 2)
	putTIFFEntry(data, 8, 0, 0x0100, 4, 1, width)
	putTIFFEntry(data, 8, 1, 0x0101, 4, 1, height)
	return data
}

func syntheticBigTIFF(width, height uint32) []byte {
	data := make([]byte, 16+8+2*20+8)
	copy(data[:2], []byte("II"))
	binary.LittleEndian.PutUint16(data[2:4], 43)
	binary.LittleEndian.PutUint16(data[4:6], 8)
	binary.LittleEndian.PutUint16(data[6:8], 0)
	binary.LittleEndian.PutUint64(data[8:16], 16)
	binary.LittleEndian.PutUint64(data[16:24], 2)
	putEntry := func(index int, tag uint16, value uint32) {
		offset := 24 + index*20
		binary.LittleEndian.PutUint16(data[offset:offset+2], tag)
		binary.LittleEndian.PutUint16(data[offset+2:offset+4], 4)
		binary.LittleEndian.PutUint64(data[offset+4:offset+12], 1)
		binary.LittleEndian.PutUint32(data[offset+12:offset+16], value)
	}
	putEntry(0, 0x0100, width)
	putEntry(1, 0x0101, height)
	return data
}

func TestDetailsReadsTIFFLikeRAWDimensionsFromHeaders(t *testing.T) {
	cases := []struct {
		name        string
		extension   string
		contentType string
		data        []byte
		width       int
		height      int
	}{
		{name: "Olympus ORF", extension: "orf", contentType: "image/x-olympus-orf", data: syntheticClassicTIFFVariant(0x4f52, 5184, 3888), width: 5184, height: 3888},
		{name: "Panasonic RW2", extension: "rw2", contentType: "image/x-panasonic-rw2", data: syntheticClassicTIFFVariant(0x0055, 6000, 4000), width: 6000, height: 4000},
		{name: "BigTIFF DNG", extension: "dng", contentType: "image/x-adobe-dng", data: syntheticBigTIFF(8256, 5504), width: 8256, height: 5504},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app, _, backend := testApplication(t)
			key := "tenant/photo." + tc.extension
			backend.mu.Lock()
			backend.objects[key] = memoryObject{data: tc.data, contentType: tc.contentType, modified: time.Now().UTC()}
			backend.mu.Unlock()
			response := requestMediaInfo(t, app, "photo."+tc.extension)
			if response.Width != tc.width || response.Height != tc.height {
				t.Fatalf("resolution = %dx%d, want %dx%d", response.Width, response.Height, tc.width, tc.height)
			}
			gets, heads, _ := backendReadCounts(backend)
			if gets != 1 || heads != 0 {
				t.Fatalf("GETs = %d, HEADs = %d", gets, heads)
			}
		})
	}
}

func fitsCard(key, value string) string {
	card := key
	if value != "" {
		card = fmt.Sprintf("%-8s= %20s", key, value)
	}
	if len(card) > 80 {
		card = card[:80]
	}
	return card + strings.Repeat(" ", 80-len(card))
}

func TestDetailsReadsAdditionalImageHeaderFormats(t *testing.T) {
	fits := []byte(fitsCard("SIMPLE", "T") + fitsCard("NAXIS", "2") + fitsCard("NAXIS1", "4096") + fitsCard("NAXIS2", "2160") + fitsCard("END", ""))
	fits = append(fits, make([]byte, 2880-len(fits))...)
	qoi := make([]byte, 14)
	copy(qoi[:4], []byte("qoif"))
	binary.BigEndian.PutUint32(qoi[4:8], 1920)
	binary.BigEndian.PutUint32(qoi[8:12], 1080)
	farbfeld := make([]byte, 16)
	copy(farbfeld[:8], []byte("farbfeld"))
	binary.BigEndian.PutUint32(farbfeld[8:12], 3000)
	binary.BigEndian.PutUint32(farbfeld[12:16], 2000)

	cases := []struct {
		key         string
		contentType string
		data        []byte
		width       int
		height      int
	}{
		{key: "image.qoi", contentType: "image/qoi", data: qoi, width: 1920, height: 1080},
		{key: "image.ff", contentType: "image/farbfeld", data: farbfeld, width: 3000, height: 2000},
		{key: "image.fits", contentType: "image/fits", data: fits, width: 4096, height: 2160},
	}
	for _, tc := range cases {
		t.Run(tc.key, func(t *testing.T) {
			app, _, backend := testApplication(t)
			backend.mu.Lock()
			backend.objects["tenant/"+tc.key] = memoryObject{data: tc.data, contentType: tc.contentType, modified: time.Now().UTC()}
			backend.mu.Unlock()
			response := requestMediaInfo(t, app, tc.key)
			if response.Width != tc.width || response.Height != tc.height {
				t.Fatalf("resolution = %dx%d, want %dx%d", response.Width, response.Height, tc.width, tc.height)
			}
		})
	}
}

type rangeIgnoringBackend struct {
	*memoryBackend
}

func (b *rangeIgnoringBackend) Get(_ context.Context, key string, requestHeaders http.Header) (objectResponse, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	object, ok := b.objects[key]
	if !ok {
		return objectResponse{}, &upstreamError{StatusCode: http.StatusNotFound, Code: "NotFound", Message: "missing"}
	}
	b.getCount++
	b.getRanges = append(b.getRanges, requestHeaders.Get("Range"))
	headers := make(http.Header)
	headers.Set("Content-Type", object.contentType)
	headers.Set("Content-Length", strconv.Itoa(len(object.data)))
	headers.Set("ETag", `"etag-`+key+`"`)
	return objectResponse{StatusCode: http.StatusOK, Header: headers, Body: io.NopCloser(bytes.NewReader(object.data))}, nil
}

func TestDetailsRejectsProviderThatIgnoresRangeForLargeObject(t *testing.T) {
	app, _, backend := testApplication(t)
	data := append(syntheticPNG(640, 480), make([]byte, 2<<20)...)
	backend.mu.Lock()
	backend.objects["tenant/large.png"] = memoryObject{data: data, contentType: "image/png", modified: time.Now().UTC()}
	backend.mu.Unlock()
	app.instances["rw"].backend = &rangeIgnoringBackend{memoryBackend: backend}

	recorder := httptest.NewRecorder()
	app.routes().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/media-info?instance=rw&key=large.png", nil))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "range_not_supported") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}
