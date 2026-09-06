"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
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
  const pathname = usePathname();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [opened, setOpened] = useState(false);

  /*
    **Abierto se deriva, no se sincroniza.**

    `/perfil` abre el modal al entrar, igual que `/registro` abre el de
    conectar. La primera versión lo hacía con un efecto que llamaba `setOpen`,
    y eso es un `setState` síncrono dentro de un efecto — el render en cascada
    que el linter marca, y una segunda fuente de verdad sobre algo que la ruta
    ya dice.

    Derivarlo resuelve las dos cosas: cerrar desde `/perfil` navega a `/`, el
    pathname cambia y el modal se cierra solo, sin que nadie tenga que acordarse
    de bajar la bandera.
  */
  const open = opened || (pathname === "/perfil" && profile !== null);

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
    setOpened(false);
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
          onClick={() => setOpened(true)}
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
        <ProfileModal
          profile={profile}
          onClose={() => {
            setOpened(false);
            // Cerrar desde `/perfil` devuelve la URL a la home, que es lo que
            // queda a la vista. La ruta directa sigue sirviendo para llegar.
            if (pathname === "/perfil") router.replace("/");
          }}
          onChanged={load}
        />
      )}
    </>
  );
}
