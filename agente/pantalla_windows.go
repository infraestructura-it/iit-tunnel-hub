//go:build windows

package main

// Captura de pantalla e inyección de entrada en Windows (GDI + SendInput).
//
// Clave: GDI (BitBlt) y SendInput van al escritorio del HILO que los llama. Una tarea programada puede
// arrancar el agente atado a otro escritorio (el de inicio de sesión), y entonces la captura sale negra y
// el teclado/ratón no llegan. Por eso todo el trabajo de pantalla corre en UN hilo dedicado que se engancha
// al escritorio de entrada (OpenInputDesktop + SetThreadDesktop) y se queda ahí.

import (
	"fmt"
	"image"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pGetSystemMetrics          = user32.NewProc("GetSystemMetrics")
	pGetDC                     = user32.NewProc("GetDC")
	pReleaseDC                 = user32.NewProc("ReleaseDC")
	pSendInput                 = user32.NewProc("SendInput")
	pSetProcessDPIAware        = user32.NewProc("SetProcessDPIAware")
	pSetProcessDpiAwarenessCtx = user32.NewProc("SetProcessDpiAwarenessContext")
	pOpenInputDesktop          = user32.NewProc("OpenInputDesktop")
	pSetThreadDesktop          = user32.NewProc("SetThreadDesktop")
	pGetUserObjectInformationW = user32.NewProc("GetUserObjectInformationW")
	pCloseDesktop              = user32.NewProc("CloseDesktop")
	pGetCursorInfo             = user32.NewProc("GetCursorInfo")
	pGetIconInfo               = user32.NewProc("GetIconInfo")
	pDrawIconEx                = user32.NewProc("DrawIconEx")
	pOpenClipboard             = user32.NewProc("OpenClipboard")
	pCloseClipboard            = user32.NewProc("CloseClipboard")
	pGetClipboardData          = user32.NewProc("GetClipboardData")
	pSetClipboardData          = user32.NewProc("SetClipboardData")
	pEmptyClipboard            = user32.NewProc("EmptyClipboard")

	pCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	pCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	pSelectObject       = gdi32.NewProc("SelectObject")
	pBitBlt             = gdi32.NewProc("BitBlt")
	pDeleteObject       = gdi32.NewProc("DeleteObject")
	pDeleteDC           = gdi32.NewProc("DeleteDC")

	pGlobalAlloc  = kernel32.NewProc("GlobalAlloc")
	pGlobalLock   = kernel32.NewProc("GlobalLock")
	pGlobalUnlock = kernel32.NewProc("GlobalUnlock")
)

const (
	smXVirtual  = 76
	smYVirtual  = 77
	smCXVirtual = 78
	smCYVirtual = 79

	srccopy    = 0x00CC0020
	captureblt = 0x40000000
	biRGB      = 0

	inputMouse    = 0
	inputKeyboard = 1

	meMove       = 0x0001
	meLeftDown   = 0x0002
	meLeftUp     = 0x0004
	meRightDown  = 0x0008
	meRightUp    = 0x0010
	meMidDown    = 0x0020
	meMidUp      = 0x0040
	meWheel      = 0x0800
	meAbsolute   = 0x8000
	meVirtualDsk = 0x4000

	keUp       = 0x0002
	keScancode = 0x0008
	keExtended = 0x0001
	wheelDelta = 120

	cfUnicodeText = 13
	gmemMoveable  = 0x0002
	uoiName       = 2

	desktopAllAccess = 0x000F01FF // enganchar el hilo al escritorio de entrada
	cursorShowing    = 0x0001
	diNormal         = 0x0003
)

func tieneCapturaPantalla() bool { return true }

type winCap struct {
	vx, vy, w, h int
	screenDC     uintptr
	memDC        uintptr
	bitmap       uintptr
	bits         unsafe.Pointer
	stride       int
	req          chan func()
	quit         chan struct{}
	deskName     string
	deskHandle   uintptr // escritorio al que está enganchado el hilo (se cierra al cambiar)
	blockedFlag  bool    // no se pudo enganchar al escritorio de entrada (p. ej. UAC sin privilegio SYSTEM)
}

func metric(i int) int {
	r, _, _ := pGetSystemMetrics.Call(uintptr(i))
	return int(int32(r))
}

// do ejecuta f en el hilo de captura (donde está enganchado el escritorio) y espera.
func (c *winCap) do(f func()) {
	done := make(chan struct{})
	select {
	case c.req <- func() { f(); close(done) }:
		<-done
	case <-c.quit:
	}
}

func newCapture() (capture, error) {
	c := &winCap{req: make(chan func()), quit: make(chan struct{})}
	ready := make(chan error, 1)
	go c.worker(ready)
	if err := <-ready; err != nil {
		return nil, err
	}
	return c, nil
}

// worker corre en un hilo fijo, enganchado al escritorio de entrada; ahí viven el DC, el DIB y el SendInput.
func (c *winCap) worker(ready chan error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if pSetProcessDpiAwarenessCtx.Find() == nil {
		pSetProcessDpiAwarenessCtx.Call(^uintptr(3)) // PER_MONITOR_AWARE_V2 (-4)
	} else {
		pSetProcessDPIAware.Call()
	}
	c.vx, c.vy = metric(smXVirtual), metric(smYVirtual)
	c.w, c.h = metric(smCXVirtual), metric(smCYVirtual)
	if c.w <= 0 || c.h <= 0 {
		ready <- fmt.Errorf("no se pudo leer el tamaño de la pantalla")
		return
	}
	c.stride = c.w * 4
	c.ensureDesktop() // engancha el escritorio de entrada y crea el DC/DIB
	ready <- nil

	for {
		select {
		case f := <-c.req:
			f()
		case <-c.quit:
			c.releaseGDI()
			if c.deskHandle != 0 {
				pCloseDesktop.Call(c.deskHandle)
			}
			return
		}
	}
}

func (c *winCap) releaseGDI() {
	if c.bitmap != 0 {
		pDeleteObject.Call(c.bitmap)
		c.bitmap = 0
	}
	if c.memDC != 0 {
		pDeleteDC.Call(c.memDC)
		c.memDC = 0
	}
	if c.screenDC != 0 {
		pReleaseDC.Call(0, c.screenDC)
		c.screenDC = 0
	}
}

func (c *winCap) createGDI() bool {
	sdc, _, _ := pGetDC.Call(0)
	if sdc == 0 {
		return false
	}
	c.screenDC = sdc
	c.memDC, _, _ = pCreateCompatibleDC.Call(sdc)
	var bi struct {
		Size                   uint32
		Width, Height          int32
		Planes, BitCount       uint16
		Compression, SizeImage uint32
		XPPM, YPPM             int32
		ClrUsed, ClrImportant  uint32
	}
	bi.Size = uint32(unsafe.Sizeof(bi))
	bi.Width = int32(c.w)
	bi.Height = -int32(c.h)
	bi.Planes = 1
	bi.BitCount = 32
	bi.Compression = biRGB
	var bits unsafe.Pointer
	hbm, _, _ := pCreateDIBSection.Call(c.memDC, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if hbm == 0 || bits == nil {
		return false
	}
	c.bitmap = hbm
	c.bits = bits
	pSelectObject.Call(c.memDC, hbm)
	return true
}

// ensureDesktop engancha el hilo al escritorio de entrada ACTUAL y rehace el DC/DIB si cambió (login→sesión,
// Default↔escritorio seguro de UAC/bloqueo). Como SYSTEM alcanza todos; sin privilegio, el escritorio seguro
// no se puede abrir y se marca como protegido. Corre en el hilo de captura.
func (c *winCap) ensureDesktop() {
	hNew, _, _ := pOpenInputDesktop.Call(0, 0, desktopAllAccess)
	if hNew == 0 {
		c.blockedFlag = true // no se puede acceder al escritorio de entrada (p. ej. UAC sin SYSTEM)
		return
	}
	name := desktopName(hNew)
	if c.deskHandle != 0 && name == c.deskName && c.screenDC != 0 {
		pCloseDesktop.Call(hNew)
		c.blockedFlag = false
		return
	}
	// Cambió el escritorio: soltar GDI, cambiar de escritorio, rehacer GDI
	c.releaseGDI()
	if r, _, _ := pSetThreadDesktop.Call(hNew); r == 0 {
		pCloseDesktop.Call(hNew)
		c.blockedFlag = true
		return
	}
	if c.deskHandle != 0 {
		pCloseDesktop.Call(c.deskHandle)
	}
	c.deskHandle = hNew
	c.deskName = name
	c.blockedFlag = !c.createGDI()
}

// drawCursor pinta el puntero del sistema sobre el DIB (corre en el hilo de captura).
func (c *winCap) drawCursor() {
	var ci struct {
		cbSize  uint32
		flags   uint32
		hCursor uintptr
		x, y    int32
	}
	ci.cbSize = uint32(unsafe.Sizeof(ci))
	if r, _, _ := pGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); r == 0 || ci.flags&cursorShowing == 0 || ci.hCursor == 0 {
		return
	}
	var ii struct {
		fIcon            int32
		xHot, yHot       uint32
		hbmMask, hbmCol  uintptr
	}
	if r, _, _ := pGetIconInfo.Call(ci.hCursor, uintptr(unsafe.Pointer(&ii))); r != 0 {
		if ii.hbmMask != 0 {
			defer pDeleteObject.Call(ii.hbmMask)
		}
		if ii.hbmCol != 0 {
			defer pDeleteObject.Call(ii.hbmCol)
		}
	}
	x := ci.x - int32(c.vx) - int32(ii.xHot)
	y := ci.y - int32(c.vy) - int32(ii.yHot)
	pDrawIconEx.Call(c.memDC, uintptr(x), uintptr(y), ci.hCursor, 0, 0, 0, 0, diNormal)
}

func desktopName(hd uintptr) string {
	var buf [64]uint16
	var need uint32
	pGetUserObjectInformationW.Call(hd, uoiName, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&need)))
	return syscall.UTF16ToString(buf[:])
}

func (c *winCap) size() (int, int) { return c.w, c.h }

func (c *winCap) grab(dst *image.RGBA) error {
	var ok uintptr
	c.do(func() {
		c.ensureDesktop() // seguir el escritorio activo (login→sesión, UAC)
		if c.blockedFlag || c.memDC == 0 {
			return
		}
		r, _, _ := pBitBlt.Call(c.memDC, 0, 0, uintptr(c.w), uintptr(c.h), c.screenDC, uintptr(int32(c.vx)), uintptr(int32(c.vy)), srccopy|captureblt)
		ok = r
		if r == 0 {
			return
		}
		c.drawCursor() // GDI no captura el puntero: se dibuja encima para que se vea moverse
		src := unsafe.Slice((*byte)(c.bits), c.h*c.stride)
		for y := 0; y < c.h; y++ {
			so := y * c.stride
			do := dst.PixOffset(0, y)
			for x := 0; x < c.w; x++ {
				s := so + x*4
				d := do + x*4
				dst.Pix[d+0] = src[s+2] // R
				dst.Pix[d+1] = src[s+1] // G
				dst.Pix[d+2] = src[s+0] // B
				dst.Pix[d+3] = 255
			}
		}
	})
	if ok == 0 {
		return fmt.Errorf("BitBlt falló")
	}
	return nil
}

// --- inyección de entrada (SendInput), también en el hilo del escritorio ---

type mouseInput struct {
	dx, dy      int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}
type keybdInput struct {
	wVk, wScan  uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}
type inputT struct {
	typ uint32
	_   uint32
	u   [32]byte // unión MOUSEINPUT/KEYBDINPUT (amd64)
}

func (c *winCap) norma(x, y int) (int32, int32) {
	den := func(n int) int {
		if n > 1 {
			return n - 1
		}
		return 1
	}
	return int32(x * 65535 / den(c.w)), int32(y * 65535 / den(c.h))
}

func (c *winCap) mouseEvent(flags uint32, data uint32, x, y int) {
	c.do(func() {
		var in inputT
		in.typ = inputMouse
		nx, ny := c.norma(x, y)
		mi := (*mouseInput)(unsafe.Pointer(&in.u[0]))
		mi.dx, mi.dy = nx, ny
		mi.mouseData = data
		mi.dwFlags = flags | meAbsolute | meVirtualDsk
		pSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	})
}

func (c *winCap) moveMouse(x, y int) { c.mouseEvent(meMove, 0, x, y) }

func (c *winCap) button(btn int, down bool, x, y int) {
	var f uint32
	switch btn {
	case 0:
		f = pick(down, meLeftDown, meLeftUp)
	case 1:
		f = pick(down, meMidDown, meMidUp)
	case 2:
		f = pick(down, meRightDown, meRightUp)
	default:
		return
	}
	c.mouseEvent(meMove|f, 0, x, y)
}

func (c *winCap) wheel(dy, x, y int) { c.mouseEvent(meWheel, uint32(int32(dy*wheelDelta)), x, y) }

func (c *winCap) key(scancode int, down, extended bool) {
	c.do(func() {
		var in inputT
		in.typ = inputKeyboard
		ki := (*keybdInput)(unsafe.Pointer(&in.u[0]))
		ki.wScan = uint16(scancode)
		ki.dwFlags = keScancode
		if extended {
			ki.dwFlags |= keExtended
		}
		if !down {
			ki.dwFlags |= keUp
		}
		pSendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	})
}

func pick(b bool, t, f uint32) uint32 {
	if b {
		return t
	}
	return f
}

// --- portapapeles de texto ---

func (c *winCap) clipboardGet() (string, bool) {
	var out string
	var ok bool
	c.do(func() {
		if r, _, _ := pOpenClipboard.Call(0); r == 0 {
			return
		}
		defer pCloseClipboard.Call()
		h, _, _ := pGetClipboardData.Call(cfUnicodeText)
		if h == 0 {
			return
		}
		p, _, _ := pGlobalLock.Call(h)
		if p == 0 {
			return
		}
		defer pGlobalUnlock.Call(h)
		var u16 []uint16
		for i := 0; ; i++ {
			ch := *(*uint16)(unsafe.Pointer(p + uintptr(i*2)))
			if ch == 0 || len(u16) > 512*1024 {
				break
			}
			u16 = append(u16, ch)
		}
		out, ok = syscall.UTF16ToString(u16), true
	})
	return out, ok
}

func (c *winCap) clipboardSet(s string) {
	u16, err := syscall.UTF16FromString(s)
	if err != nil {
		return
	}
	c.do(func() {
		if r, _, _ := pOpenClipboard.Call(0); r == 0 {
			return
		}
		defer pCloseClipboard.Call()
		pEmptyClipboard.Call()
		hMem, _, _ := pGlobalAlloc.Call(gmemMoveable, uintptr(len(u16)*2))
		if hMem == 0 {
			return
		}
		p, _, _ := pGlobalLock.Call(hMem)
		if p == 0 {
			return
		}
		for i, ch := range u16 {
			*(*uint16)(unsafe.Pointer(p + uintptr(i*2))) = ch
		}
		pGlobalUnlock.Call(hMem)
		pSetClipboardData.Call(cfUnicodeText, hMem)
	})
}

// blocked: se reporta protegido solo si el agente NO pudo engancharse al escritorio de entrada actual
// (típico de UAC/bloqueo cuando no corre como SYSTEM). Como SYSTEM se engancha a todos y nunca bloquea.
func (c *winCap) blocked() (bool, string) {
	var b bool
	c.do(func() { c.ensureDesktop(); b = c.blockedFlag })
	if b {
		return true, "El equipo está en una pantalla protegida de Windows (control de cuentas de usuario o bloqueo) y el agente no tiene permiso para mostrarla. Se verá cuando el usuario la cierre, o instale el agente como administrador para que la muestre."
	}
	return false, ""
}

func (c *winCap) close() {
	select {
	case <-c.quit:
	default:
		close(c.quit)
	}
}

// diagPantalla imprime en qué sesión corre el agente, cuál es la sesión de consola activa y el escritorio de
// entrada. Sirve para ver si el agente quedó en otra sesión que la del usuario (causa típica de pantalla negra).
var (
	kernel32b                       = syscall.NewLazyDLL("kernel32.dll")
	pWTSGetActiveConsoleSessionId   = kernel32b.NewProc("WTSGetActiveConsoleSessionId")
	pProcessIdToSessionId           = kernel32b.NewProc("ProcessIdToSessionId")
	pGetCurrentProcessId            = kernel32b.NewProc("GetCurrentProcessId")
)

func diagPantalla() {
	pid, _, _ := pGetCurrentProcessId.Call()
	var mySess uint32
	pProcessIdToSessionId.Call(pid, uintptr(unsafe.Pointer(&mySess)))
	consoleSess, _, _ := pWTSGetActiveConsoleSessionId.Call()
	desk := "(no accesible)"
	if h, _, _ := pOpenInputDesktop.Call(0, 0, 0x0001); h != 0 {
		desk = desktopName(h)
		pCloseDesktop.Call(h)
	}
	fmt.Printf("agente: sesion=%d  consola_activa=%d  escritorio_entrada=%q\n", mySess, int32(consoleSess), desk)
	if mySess != uint32(int32(consoleSess)) {
		fmt.Println("AVISO: el agente NO está en la sesión del usuario que ve la pantalla; por eso sale negra.")
	}
}
