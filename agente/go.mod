module github.com/infraestructura-it/iit-tunnel-hub/agente

go 1.23.0

toolchain go1.24.7

// golang.org/x se toma de sus espejos en GitHub (mismo código); así se compila sin proxy.golang.org
replace golang.org/x/crypto => github.com/golang/crypto v0.40.0

replace golang.org/x/net => github.com/golang/net v0.42.0

replace golang.org/x/sys => github.com/golang/sys v0.34.0

replace golang.org/x/text => github.com/golang/text v0.27.0

replace golang.org/x/time => github.com/golang/time v0.12.0

require (
	github.com/gorilla/websocket v1.5.3
	github.com/pion/webrtc/v4 v4.1.6
)

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/pion/datachannel v1.5.10 // indirect
	github.com/pion/dtls/v3 v3.0.7 // indirect
	github.com/pion/ice/v4 v4.0.10 // indirect
	github.com/pion/interceptor v0.1.41 // indirect
	github.com/pion/logging v0.2.4 // indirect
	github.com/pion/mdns/v2 v2.0.7 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/rtcp v1.2.15 // indirect
	github.com/pion/rtp v1.8.23 // indirect
	github.com/pion/sctp v1.8.40 // indirect
	github.com/pion/sdp/v3 v3.0.16 // indirect
	github.com/pion/srtp/v3 v3.0.8 // indirect
	github.com/pion/stun/v3 v3.0.0 // indirect
	github.com/pion/transport/v3 v3.0.8 // indirect
	github.com/pion/turn/v4 v4.1.1 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	golang.org/x/crypto v0.40.0 // indirect
	golang.org/x/net v0.41.0 // indirect
	golang.org/x/sys v0.34.0 // indirect
)
