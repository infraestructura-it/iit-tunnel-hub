//go:build !windows

package main

import "log"

func defaultConfigPath() string { return "/etc/iit-frpc/agente.json" }

func runSupervisor(cfg string) { log.Fatal("el modo supervisor solo existe en Windows") }
