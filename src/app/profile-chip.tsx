"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnectWallet } from "./connect-wallet";
import { ProfileModal } from "./profile-modal";
import type { Profile } from "@/lib/profile";
import { VerifiedTick } from "./verified-tick";

/**
 * El chip del header: avatar + `@handle` + `salir` cuando hay sesión, y el botón
 * `Connect Wallet` cuando no.
 *
 * **Es el mismo slot del molde**, que ahí lleva el usuario logueado. Hasta el
 * 2026-09-06 este producto no tenía sesiones y el slot llevaba la acción de
 * conectar, con un comentario en `layout.tsx` explicando que un chip con avatar
 * y handle habría sido *"una sesión que este sitio no puede tener"*. Ahora la
 * tiene (`DECISIONES.md`), y el slot dice lo que el molde dice.
 *
 * **El perfil se pide una vez, al montar.** Si no hay sesión, `/api/perfil`
 * contesta 401 y el chip se queda con el botón de conectar — que es el estado
 * correcto y no un error que haya que mostrar.
 */
export function ProfileChip() {
  const connect = useConnectWallet();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/perfil", { cache: "no-store" });
      setProfile(response.ok ? ((await response.json()) as Profile) : null);
    } catch {
      // Sin red no hay sesión que mostrar; el chip vuelve a `Connect Wallet`.
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    /*
      El `void load()` directo lo marca la regla de "no llamar setState de forma
      síncrona en un efecto": `load` es async, pero su primer `await` puede
      resolverse en el mismo tick si la respuesta viene de caché, y el linter no
      puede saberlo. Un microtask de por medio lo separa del render sin cambiar
      nada de lo que hace.
    */
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const leave = useCallback(async () => {
    await fetch("/api/salir", { method: "POST" });
    setProfile(null);
    setOpen(false);
    // La página vuelve a pedir lo suyo: el ranking no cambia, pero cualquier
    // cosa que dependa de la sesión sí.
    window.location.reload();
  }, []);

  if (profile === null) {
    return (
      <a
        className="registro"
        href="/registro"
        onClick={(event) => {
          if (connect === null) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          if (event.button !== 0) return;
          event.preventDefault();
          connect.open();
        }}
      >
        Connect Wallet
      </a>
    );
  }

  return (
    <>
      <span className="profile-chip">
        <button
          type="button"
          className="profile-chip__open"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- el avatar lo
              sirve nuestra propia ruta, ya dimensionado. */}
          <img src={profile.avatarUrl} alt="" width={24} height={24} className="profile-chip__avatar" />
          <span className="profile-chip__handle">@{profile.handle}</span>
          <VerifiedTick verified={profile.handleVerified} />
        </button>
        <button type="button" className="profile-chip__leave" onClick={leave}>
          Salir
        </button>
      </span>

      {open && (
        <ProfileModal profile={profile} onClose={() => setOpen(false)} onChanged={load} />
      )}
    </>
  );
}
