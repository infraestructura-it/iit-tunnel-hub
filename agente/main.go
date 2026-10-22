// iit-agente — agente de IIT Tunnel Hub para compartir pantalla por WebRTC.
//
// Corre en el equipo del cliente junto a frpc. Mantiene un WebSocket con el hub (autenticado con el
// token de la máquina) y, cuando un técnico abre "Pantalla" en el panel, recibe la oferta WebRTC del
// navegador, la responde y conecta el canal de datos "rfb" con el servidor VNC local (wayvnc en la
// Raspberry). La imagen viaja directo entre el navegador y el equipo; el hub solo los presenta.
//
//	iit-agente -config /etc/iit-frpc/agente.json   servicio normal
//	iit-agente probar <ws-url-con-ticket>          prueba: hace de navegador (usado por test/e2e.sh)
//	iit-agente version
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image/jpeg"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

const version = "1.0.0"

type config struct {
	Hub     string `json:"hub"`     // http(s)://host:puerto del hub
	Machine string `json:"machine"` // id de la máquina (usuario frp)
	Token   string `json:"token"`   // token de la máquina (el mismo de frpc)
}

// Mensajes con el hub
type msg struct {
	Type     string             `json:"type"`
	ID       string             `json:"id,omitempty"`
	SDP      string             `json:"sdp,omitempty"`
	Target   string             `json:"target,omitempty"`
	Kind     string             `json:"kind,omitempty"` // "rfb" (puente a VNC) o "pantalla" (captura del agente)
	Ice      []webrtc.ICEServer `json:"ice,omitempty"`
	Message  string             `json:"message,omitempty"`
	Estado   string             `json:"estado,omitempty"`
	BytesIn  int64              `json:"bytesIn,omitempty"`
	BytesOut int64              `json:"bytesOut,omitempty"`
	Version  string             `json:"version,omitempty"`
	OS       string             `json:"os,omitempty"`  // sistema del equipo (hola)
	Cap      []string           `json:"cap,omitempty"` // capacidades del agente, p. ej. ["pantalla"] (hola)
}

const chunk = 16 * 1024 // tamaño máximo por mensaje del canal de datos (compatible con todos los navegadores)

func main() {
	log.SetFlags(log.LstdFlags)
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "diag" {
		diagPantalla()
		return
	}
	if len(os.Args) > 2 && os.Args[1] == "probar" {
		modo := "rfb"
		if len(os.Args) > 3 {
			modo = os.Args[3]
		}
		if modo == "pantalla" {
			os.Exit(probarPantalla(os.Args[2]))
		}
		os.Exit(probar(os.Args[2]))
	}
	cfgPath := flag.String("config", defaultConfigPath(), "archivo de configuración")
	supervisor := flag.Bool("supervisor", false, "modo servicio: lanza un trabajador en la sesión activa (Windows)")
	flag.Parse()
	if *supervisor {
		runSupervisor(*cfgPath)
		return
	}
	raw, err := os.ReadFile(*cfgPath)
	if err != nil {
		log.Fatalf("no se pudo leer %s: %v", *cfgPath, err)
	}
	var cfg config
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.Hub == "" || cfg.Machine == "" || cfg.Token == "" {
		log.Fatalf("configuración incompleta en %s (hub, machine, token)", *cfgPath)
	}
	log.Printf("iit-agente %s · máquina %s · hub %s", version, cfg.Machine, cfg.Hub)
	backoff := time.Second
	for {
		start := time.Now()
		err := run(cfg)
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		log.Printf("desconectado del hub: %v · reintento en %s", err, backoff)
		time.Sleep(backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// wsURL convierte la URL del hub en la del WebSocket del agente.
func wsURL(hub string) (string, error) {
	u, err := url.Parse(strings.TrimRight(hub, "/"))
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("hub debe empezar con http:// o https://")
	}
	u.Path += "/api/agent/ws"
	return u.String(), nil
}

// run mantiene una conexión con el hub hasta que se corta.
func run(cfg config) error {
	u, err := wsURL(cfg.Hub)
	if err != nil {
		return err
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+cfg.Token)
	h.Set("X-IIT-Machine", cfg.Machine)
	h.Set("X-IIT-Version", version)
	d := websocket.Dialer{HandshakeTimeout: 15 * time.Second, Proxy: http.ProxyFromEnvironment}
	conn, resp, err := d.Dial(u, h)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("%v (HTTP %d)", err, resp.StatusCode)
		}
		return err
	}
	defer conn.Close()
	log.Printf("conectado al hub")

	var wmu sync.Mutex
	send := func(m msg) {
		wmu.Lock()
		defer wmu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_ = conn.WriteJSON(m)
	}
	// Se anuncia: sistema y capacidades (pantalla = captura propia, hoy solo Windows)
	send(msg{Type: "hola", OS: runtime.GOOS, Cap: capacidades(), Version: version})
	// Mantener viva la conexión (proxies y NAT cortan conexiones inactivas)
	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(25 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				wmu.Lock()
				_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
				wmu.Unlock()
			}
		}
	}()

	sessions := map[string]*session{}
	var smu sync.Mutex
	defer func() {
		smu.Lock()
		for _, s := range sessions {
			s.close()
		}
		smu.Unlock()
	}()
	for {
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
		var m msg
		if err := conn.ReadJSON(&m); err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		switch m.Type {
		case "offer":
			s := &session{id: m.ID, target: m.Target, kind: m.Kind, send: send, closed: make(chan struct{})}
			smu.Lock()
			sessions[m.ID] = s
			smu.Unlock()
			go func() {
				s.start(m)
				smu.Lock()
				delete(sessions, m.ID)
				smu.Unlock()
			}()
		case "cerrar":
			smu.Lock()
			if s := sessions[m.ID]; s != nil {
				s.close()
			}
			smu.Unlock()
		}
	}
}

type session struct {
	id     string
	target string
	kind   string // "rfb" o "pantalla"
	send    func(msg)
	pc      *webrtc.PeerConnection
	once    sync.Once
	closed  chan struct{}
	refresh chan struct{} // sesión de pantalla: pedir cuadro completo
}

func (s *session) close() {
	s.once.Do(func() {
		close(s.closed)
		if s.pc != nil {
			_ = s.pc.Close()
		}
	})
}

// allowedTarget limita el destino a una dirección IP:puerto (la que el hub tiene registrada para el servicio).
func allowedTarget(t string) error {
	host, port, err := net.SplitHostPort(t)
	if err != nil || port == "" {
		return fmt.Errorf("destino no válido: %q", t)
	}
	if net.ParseIP(host) == nil && host != "localhost" {
		return fmt.Errorf("el destino debe ser una IP: %q", t)
	}
	return nil
}

// start responde la oferta y, cuando se abre el canal, lo conecta con el servicio local.
func (s *session) start(offer msg) {
	fail := func(err error) {
		log.Printf("sesión %s: %v", s.id, err)
		s.send(msg{Type: "error", ID: s.id, Message: err.Error()})
		s.close()
	}
	if s.kind == "pantalla" {
		if !tieneCapturaPantalla() {
			fail(fmt.Errorf("este equipo no puede compartir pantalla con el agente (solo Windows por ahora)"))
			return
		}
	} else if err := allowedTarget(s.target); err != nil {
		fail(err)
		return
	}
	pc, err := newPeer(offer.Ice)
	if err != nil {
		fail(err)
		return
	}
	s.pc = pc
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.close()
		}
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		switch dc.Label() {
		case "rfb":
			dc.OnOpen(func() { go s.bridge(dc) })
		case "pantalla":
			dc.OnOpen(func() { go s.pantalla(dc) })
		default:
			_ = dc.Close()
		}
	})
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		fail(fmt.Errorf("oferta no válida: %w", err))
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		fail(err)
		return
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		fail(err)
		return
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second): // con lo reunido hasta ahora
	}
	s.send(msg{Type: "answer", ID: s.id, SDP: pc.LocalDescription().SDP})
	log.Printf("sesión %s: respuesta enviada (destino %s)", s.id, s.target)
	// Si en 30 s no se abre el canal, se libera
	select {
	case <-s.closed:
	case <-time.After(30 * time.Second):
		if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			s.close()
		}
		<-s.closed
	}
}

func newPeer(ice []webrtc.ICEServer) (*webrtc.PeerConnection, error) {
	se := webrtc.SettingEngine{}
	se.SetICETimeouts(5*time.Second, 15*time.Second, 2*time.Second)
	// Solo IPv4 (ZeroTier, LAN e Internet IPv4): evita errores de mDNS/IPv6 en equipos sin IPv6
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	return api.NewPeerConnection(webrtc.Configuration{ICEServers: ice})
}

// bridge copia bytes entre el canal de datos y la conexión TCP local (protocolo RFB de punta a punta).
func (s *session) bridge(dc *webrtc.DataChannel) {
	tcp, err := net.DialTimeout("tcp", s.target, 5*time.Second)
	if err != nil {
		log.Printf("sesión %s: no se pudo conectar a %s: %v", s.id, s.target, err)
		s.send(msg{Type: "error", ID: s.id, Message: fmt.Sprintf("el servidor VNC no responde en %s", s.target)})
		_ = dc.Close()
		s.close()
		return
	}
	log.Printf("sesión %s: canal abierto ⇄ %s", s.id, s.target)
	s.send(msg{Type: "estado", ID: s.id, Estado: "abierto"})
	var in, out int64
	var mu sync.Mutex
	finish := func() {
		mu.Lock()
		defer mu.Unlock()
		_ = tcp.Close()
	}
	// navegador → equipo
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		out += int64(len(m.Data))
		if _, err := tcp.Write(m.Data); err != nil {
			finish()
		}
	})
	dc.OnClose(func() { finish(); s.close() })
	// equipo → navegador, con contrapresión por bufferedAmount
	const high = 1 << 20
	dc.SetBufferedAmountLowThreshold(256 * 1024)
	low := make(chan struct{}, 1)
	dc.OnBufferedAmountLow(func() {
		select {
		case low <- struct{}{}:
		default:
		}
	})
	buf := make([]byte, chunk)
	for {
		n, err := tcp.Read(buf)
		if n > 0 {
			in += int64(n)
			for dc.BufferedAmount() > high {
				select {
				case <-low:
				case <-s.closed:
					return
				case <-time.After(5 * time.Second):
				}
			}
			if serr := dc.Send(append([]byte(nil), buf[:n]...)); serr != nil {
				break
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				log.Printf("sesión %s: %v", s.id, err)
			}
			break
		}
	}
	finish()
	s.send(msg{Type: "estado", ID: s.id, Estado: "cerrado", BytesIn: in, BytesOut: out})
	log.Printf("sesión %s: cerrada (%d B al navegador, %d B al equipo)", s.id, in, out)
	_ = dc.Close()
	s.close()
}

// probar hace de navegador contra el hub (pruebas): oferta, respuesta, canal "rfb", saludo RFB y eco.
func probar(wsu string) int {
	fail := func(f string, a ...any) int { fmt.Printf("ERROR "+f+"\n", a...); return 1 }
	conn, _, err := websocket.DefaultDialer.Dial(wsu, nil)
	if err != nil {
		return fail("rechazado: %v", err)
	}
	defer conn.Close()
	pc, err := newPeer(nil)
	if err != nil {
		return fail("%v", err)
	}
	defer pc.Close()
	ordered := true
	dc, err := pc.CreateDataChannel("rfb", &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		return fail("%v", err)
	}
	got := make(chan []byte, 16)
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) { got <- m.Data })
	offer, _ := pc.CreateOffer(nil)
	gathered := webrtc.GatheringCompletePromise(pc)
	_ = pc.SetLocalDescription(offer)
	<-gathered
	if err := conn.WriteJSON(map[string]string{"type": "offer", "sdp": pc.LocalDescription().SDP}); err != nil {
		return fail("%v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	for {
		var m msg
		if err := conn.ReadJSON(&m); err != nil {
			return fail("sin respuesta del hub: %v", err)
		}
		if m.Type == "error" {
			return fail("%s", m.Message)
		}
		if m.Type == "answer" {
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.SDP}); err != nil {
				return fail("%v", err)
			}
			break
		}
	}
	select {
	case <-opened:
	case <-time.After(10 * time.Second):
		return fail("el canal WebRTC no se abrió")
	}
	_ = conn.WriteJSON(map[string]string{"type": "conectado"})
	var acc []byte
	deadline := time.After(10 * time.Second)
	step := 0
	for {
		select {
		case b := <-got:
			acc = append(acc, b...)
			if step == 0 && strings.HasPrefix(string(acc), "RFB 003.008") {
				step, acc = 1, nil
				_ = dc.SendText("hola-vnc")
			} else if step == 1 && strings.Contains(string(acc), "hola-vnc") {
				fmt.Println("OK saludo RFB y eco por WebRTC directo")
				return 0
			}
		case <-deadline:
			return fail("no llegó el saludo/eco por el canal (paso %d)", step)
		}
	}
}

// probarPantalla hace de navegador para una sesión de pantalla: canal "pantalla", recibe init y mosaicos,
// decodifica un mosaico (JPEG) y manda un movimiento de ratón. Usado por test/e2e.sh.
func probarPantalla(wsu string) int {
	fail := func(f string, a ...any) int { fmt.Printf("ERROR "+f+"\n", a...); return 1 }
	conn, _, err := websocket.DefaultDialer.Dial(wsu, nil)
	if err != nil {
		return fail("rechazado: %v", err)
	}
	defer conn.Close()
	pc, err := newPeer(nil)
	if err != nil {
		return fail("%v", err)
	}
	defer pc.Close()
	ordered := true
	dc, err := pc.CreateDataChannel("pantalla", &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		return fail("%v", err)
	}
	got := make(chan []byte, 256)
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		select {
		case got <- m.Data:
		default:
		}
	})
	offer, _ := pc.CreateOffer(nil)
	gathered := webrtc.GatheringCompletePromise(pc)
	_ = pc.SetLocalDescription(offer)
	<-gathered
	if err := conn.WriteJSON(map[string]string{"type": "offer", "sdp": pc.LocalDescription().SDP}); err != nil {
		return fail("%v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	for {
		var m msg
		if err := conn.ReadJSON(&m); err != nil {
			return fail("sin respuesta del hub: %v", err)
		}
		if m.Type == "error" {
			return fail("%s", m.Message)
		}
		if m.Type == "answer" {
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: m.SDP}); err != nil {
				return fail("%v", err)
			}
			break
		}
	}
	select {
	case <-opened:
	case <-time.After(10 * time.Second):
		return fail("el canal de pantalla no se abrió")
	}
	gotInit, gotTile := false, false
	deadline := time.After(10 * time.Second)
	for !gotTile {
		select {
		case b := <-got:
			if len(b) == 0 {
				continue
			}
			switch b[0] {
			case opInit:
				gotInit = true
				// mover el ratón al centro declarado
				var in struct{ W, H int }
				_ = json.Unmarshal(b[1:], &in)
				var ev [5]byte
				ev[0] = opMove
				binary.BigEndian.PutUint16(ev[1:], uint16(in.W/2))
				binary.BigEndian.PutUint16(ev[3:], uint16(in.H/2))
				_ = dc.Send(ev[:])
			case opTile:
				if !gotInit || len(b) < 9 {
					continue
				}
				if _, err := jpeg.Decode(bytes.NewReader(b[9:])); err != nil {
					return fail("mosaico no es JPEG válido: %v", err)
				}
				gotTile = true
			}
		case <-deadline:
			return fail("no llegaron init+mosaicos (init=%v)", gotInit)
		}
	}
	fmt.Println("OK pantalla por WebRTC: init, mosaicos JPEG y envío de entrada")
	return 0
}
