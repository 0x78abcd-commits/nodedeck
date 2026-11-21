package main

import (
	"net/http"
	"net/http/httptest"
)

func httptestReq(ua string) *http.Request {
	r := httptest.NewRequest("GET", "/sub/x", nil)
	r.Header.Set("User-Agent", ua)
	return r
}
