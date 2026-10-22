//go:build windows

package main

// Modo supervisor (servicio del sistema). La tarea "IIT agente" lo arranca como SYSTEM al iniciar el equipo.
// El supervisor NO habla con el hub: vigila cuál es la sesión de consola activa y lanza un TRABAJADOR
// (el mismo exe con -config, sin -supervisor) EN esa sesión y con privilegio SYSTEM. Así el trabajador:
//   - captura el escritorio que el usuario ve de verdad (misma sesión), y
//   - puede inyectar teclado/ratón en cualquier ventana, incluidas las elevadas (SYSTEM > alto).
// Si el usuario cambia de sesión (otro inicio de sesión, RDP), relanza el trabajador en la nueva.

import (
	"fmt"
	"log"
	"os"
	"syscall"
	"time"
	"unsafe"
)

func defaultConfigPath() string {
	if pd := os.Getenv("ProgramData"); pd != "" {
		return pd + `\iit-frpc\agente.json`
	}
	return `C:\ProgramData\iit-frpc\agente.json`
}

var (
	advapi32  = syscall.NewLazyDLL("advapi32.dll")
	kernel32c = syscall.NewLazyDLL("kernel32.dll")

	pGetCurrentProcess            = kernel32c.NewProc("GetCurrentProcess")
	pWaitForSingleObject          = kernel32c.NewProc("WaitForSingleObject")
	pTerminateProcess             = kernel32c.NewProc("TerminateProcess")
	pCloseHandle                  = kernel32c.NewProc("CloseHandle")

	pOpenProcessToken     = advapi32.NewProc("OpenProcessToken")
	pDuplicateTokenEx     = advapi32.NewProc("DuplicateTokenEx")
	pSetTokenInformation  = advapi32.NewProc("SetTokenInformation")
	pCreateProcessAsUserW = advapi32.NewProc("CreateProcessAsUserW")
)

const (
	tokenDuplicate      = 0x0002
	tokenQuery          = 0x0008
	tokenAssignPrimary  = 0x0001
	tokenAdjustDefault  = 0x0080
	tokenAdjustSession  = 0x0100
	maximumAllowed      = 0x02000000
	securityIdent       = 1 // SecurityIdentification
	tokenPrimary        = 1
	tokenSessionIDClass = 12 // TokenSessionId
	createNoWindow      = 0x08000000
	waitTimeout         = 0x00000102
	noSession           = 0xFFFFFFFF
)

type startupInfoW struct {
	cb            uint32
	_             uint32
	lpReserved    *uint16
	lpDesktop     *uint16
	lpTitle       *uint16
	dwX           uint32
	dwY           uint32
	dwXSize       uint32
	dwYSize       uint32
	dwXCountChars uint32
	dwYCountChars uint32
	dwFillAttr    uint32
	dwFlags       uint32
	wShowWindow   uint16
	cbReserved2   uint16
	_             uint32
	lpReserved2   uintptr
	hStdInput     uintptr
	hStdOutput    uintptr
	hStdError     uintptr
}

type processInfoW struct {
	hProcess    uintptr
	hThread     uintptr
	dwProcessID uint32
	dwThreadID  uint32
}

func activeSession() uint32 {
	r, _, _ := pWTSGetActiveConsoleSessionId.Call()
	return uint32(r)
}

func alive(h uintptr) bool {
	if h == 0 {
		return false
	}
	r, _, _ := pWaitForSingleObject.Call(h, 0)
	return uint32(r) == waitTimeout
}

// spawnInSession lanza el trabajador (iit-agente -config <cfg>) como SYSTEM en la sesión dada.
func spawnInSession(sess uint32, cfg string) (uintptr, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	// Token SYSTEM propio → duplicar como primario → ponerle la sesión de consola activa
	cur, _, _ := pGetCurrentProcess.Call()
	var tok uintptr
	if r, _, e := pOpenProcessToken.Call(cur, tokenDuplicate|tokenQuery|tokenAssignPrimary|tokenAdjustDefault|tokenAdjustSession, uintptr(unsafe.Pointer(&tok))); r == 0 {
		return 0, fmt.Errorf("OpenProcessToken: %v", e)
	}
	defer pCloseHandle.Call(tok)
	var dup uintptr
	if r, _, e := pDuplicateTokenEx.Call(tok, maximumAllowed, 0, securityIdent, tokenPrimary, uintptr(unsafe.Pointer(&dup))); r == 0 {
		return 0, fmt.Errorf("DuplicateTokenEx: %v", e)
	}
	defer pCloseHandle.Call(dup)
	s := sess
	if r, _, e := pSetTokenInformation.Call(dup, tokenSessionIDClass, uintptr(unsafe.Pointer(&s)), 4); r == 0 {
		return 0, fmt.Errorf("SetTokenInformation(session): %v", e)
	}

	appName, _ := syscall.UTF16PtrFromString(exe)
	cmd := fmt.Sprintf(`"%s" -config "%s"`, exe, cfg)
	cmdLine, _ := syscall.UTF16PtrFromString(cmd)
	desktop, _ := syscall.UTF16PtrFromString(`WinSta0\Default`)
	si := startupInfoW{lpDesktop: desktop}
	si.cb = uint32(unsafe.Sizeof(si))
	var pi processInfoW
	r, _, e := pCreateProcessAsUserW.Call(dup, uintptr(unsafe.Pointer(appName)), uintptr(unsafe.Pointer(cmdLine)),
		0, 0, 0, createNoWindow, 0, 0, uintptr(unsafe.Pointer(&si)), uintptr(unsafe.Pointer(&pi)))
	if r == 0 {
		return 0, fmt.Errorf("CreateProcessAsUser: %v", e)
	}
	pCloseHandle.Call(pi.hThread)
	return pi.hProcess, nil
}

func runSupervisor(cfg string) {
	log.Printf("iit-agente %s · supervisor (SYSTEM) · config %s", version, cfg)
	var curSess uint32 = noSession
	var worker uintptr
	for {
		sess := activeSession()
		if sess != noSession && (sess != curSess || !alive(worker)) {
			if worker != 0 {
				pTerminateProcess.Call(worker, 0)
				pCloseHandle.Call(worker)
				worker = 0
			}
			h, err := spawnInSession(sess, cfg)
			if err != nil {
				log.Printf("supervisor: no se pudo lanzar el trabajador en la sesión %d: %v", sess, err)
			} else {
				worker, curSess = h, sess
				log.Printf("supervisor: trabajador lanzado en la sesión %d", sess)
			}
		}
		time.Sleep(2 * time.Second)
	}
}
