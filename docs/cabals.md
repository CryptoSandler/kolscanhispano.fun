# Cabals: quién puede hacer qué

Una página, para tener a mano. Los **cabals** son grupos de KOLs que compiten por
ganancias en `/cabals`. Todo lo que cambia un cabal lo firma una persona con su
wallet — **no hay sesión**: cada acción se firma en el momento, y esa firma vale
para esa acción y para ninguna otra.

Todo se hace desde **`/mi-cabal`**. El admin usa `/admin`.

## Los cinco roles

| Rol | Cómo se llega | Cuántos |
|---|---|---|
| **KOL sin cabal** | Estar aprobado en el padrón | — |
| **Miembro** | Pedir entrar y que te acepten | sin tope |
| **Co-líder** | Que el líder te nombre | **2 por cabal** |
| **Líder** | Crear el cabal, o recibirlo | 1 |
| **Admin** | Fede | 1 |

## Qué puede hacer cada uno

| Acción | Quién | Notas |
|---|---|---|
| **Crear un cabal** | Cualquier KOL aprobado sin cabal | Queda como líder. La sigla es suya mientras exista. |
| **Pedir entrar** | Cualquier KOL aprobado sin cabal | Uno pendiente por cabal. Si te rechazan, podés volver a pedir. |
| **Ver mi solicitud** | Quien la hizo | Solo el estado de la propia. Nunca la cola ni la posición. |
| **Ver solicitudes** | Líder y co-líderes | **La cola no es pública, nunca.** |
| **Aceptar / rechazar** | Líder y co-líderes | Aceptar mueve al KOL al cabal. |
| **Expulsar** | Líder y co-líderes | Al líder no se lo puede expulsar. Nadie se expulsa a sí mismo. |
| **Nombrar co-líder** | **Solo el líder** | Máximo dos. Tiene que ser miembro. |
| **Revocar co-líder** | **Solo el líder** | La persona sigue en el cabal. |
| **Transferir el cabal** | **Solo el líder** | A un miembro. El líder viejo sigue en el cabal. |
| **Reclamar un cabal** | Solo quien fue nominado | Ver *cabal huérfano*, abajo. |

Un co-líder puede casi todo lo del líder **menos tres cosas**: nombrar o revocar
co-líderes, y transferir el cabal. No es un olvido — un co-líder que pudiera
nombrar co-líderes volvería el tope de dos una formalidad, y uno que pudiera
transferir podría quedarse con el grupo de quien lo nombró.

## El cabal huérfano

Un cabal queda **huérfano** cuando nadie puede firmar por él: el líder no tiene
wallet activa, o no está aprobado, o directamente no hay líder — **y** no hay
ningún co-líder.

No se arregla solo. No hay temporizador y nadie se auto-promueve. Se arregla en
**dos pasos, de dos personas**:

1. **Fede nomina** desde `/admin`, donde los huérfanos aparecen listados con el
   motivo por el que lo son y cuántos miembros tienen. Hay que escribir un motivo
   y confirmar. **Nominar no mueve nada**: el cabal sigue huérfano hasta el paso 2.
2. **La persona nominada lo reclama** desde `/mi-cabal`, firmando. Recién ahí
   cambia de manos.

La nominación **vence a los 7 días**. Si vence, no pasa nada y se puede nominar de
nuevo. Si en el medio el cabal se arregla solo — el líder viejo registra otra
wallet, o aparece un co-líder — el reclamo se rechaza: ya no hay nada que reparar.

El cabal muestra después, en público: *"Reasignado por admin, reclamado por @x el
D"*. **El motivo no se publica nunca** — queda en la auditoría. Un motivo describe
la situación de una persona, y publicarlo convertiría una reparación en un castigo.

## Lo que Fede no puede hacer

Vale la pena decirlo al derecho, porque es una decisión y no una limitación:

- **No puede entregar un cabal.** Solo nominar. Quien recibe tiene que firmar.
- **No puede editar un cabal creado por un líder**, salvo una baja o un huérfano.
- **No puede retirarle la wallet a un KOL.** Eso lo hace el KOL, firmando.
- **No puede borrar ni editar la auditoría.** Hay disparadores que lo impiden y
  cada fila encadena con la anterior. Con acceso a la base igual se podría — lo
  que *no* se puede falsificar es la firma que autorizó cada acción.

## Si algo sale mal

- **"La firma ya no sirve"** — se pide una firma nueva cada vez, y cada una vale
  una sola vez. Volvé a intentar.
- **"Esa wallet no figura en el padrón"** — o el perfil no está aprobado todavía,
  o esa wallet fue retirada.
- **Perdiste la wallet y sos líder** — si tenés co-líder, transferile el cabal
  mientras todavía podés firmar. Si no, avisale a Fede: queda huérfano y se
  resuelve por nominación.
