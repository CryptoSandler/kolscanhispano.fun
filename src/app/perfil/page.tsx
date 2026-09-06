import HomePage from "../page";

/**
 * `/perfil` — la misma home, con el modal del perfil abierto encima.
 *
 * Misma forma que `/registro`: la ruta existe, **conserva su URL** y renderiza
 * lo que hay debajo del diálogo, que es la clasificación. `ProfileChip` la mira
 * y abre el modal.
 *
 * **Existe porque una ruta que no existe no se puede enlazar.** El perfil se
 * abría sólo desde el chip del header, así que no había forma de mandarle a
 * alguien el enlace de su propio perfil, ni de volver a él después de un
 * refresh. Un modal sin URL es una pantalla que no se puede compartir ni
 * marcar, y `/registro` ya había resuelto esto mismo el 2026-09-05.
 *
 * **Sin sesión no redirige: muestra la home con el modal de conectar.** Mandar
 * a `/registro` sería adivinar que el que entró quiere registrarse, cuando lo
 * más probable es que su sesión venció; `ProfileChip` ya sabe distinguir los
 * dos casos y muestra el que corresponde.
 */
export default HomePage;
