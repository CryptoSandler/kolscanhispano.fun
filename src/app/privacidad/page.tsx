/**
 * `/privacidad` — cómo protegemos las wallets, en una página propia.
 *
 * **Vivía en `/trade`**, que se eliminó el 2026-09-06 hasta que haya terminal
 * socio (`DECISIONES.md`). El contenido no cambió: cada línea corresponde a un
 * mecanismo que existe y a un test que lo sostiene, y ninguna es una promesa a
 * futuro. Se mudó entera en vez de reescribirse, porque lo que decía era cierto
 * y sigue siéndolo.
 *
 * Se llega desde el enlace `Privacidad` del pie, que es donde alguien la busca.
 */
export const metadata = {
  title: "Privacidad",
  description: "Qué hacemos con tus wallets, y qué test lo sostiene.",
};

export default function PrivacidadPage() {
  return (
    <>
      <div className="page-head">
        <h1 className="display-lg">Cómo protegemos tus wallets</h1>
        <p className="page-subtitle">
          Lo que efectivamente hacemos, no lo que nos gustaría. Cada punto tiene un mecanismo
          detrás y un test que falla si deja de ser cierto.
        </p>
      </div>

      <ul className="privacy-list">
        <li>
          <strong>Privadas por defecto.</strong> Una wallet se publica sólo si su
          dueño la marca como pública, wallet por wallet. `is_public` es esa
          elección y es lo único que la habilita.
        </li>
        <li>
          <strong>Ni truncadas.</strong> De una wallet que no elegiste mostrar no
          aparece nada en la página: ni la dirección, ni sus primeros caracteres.
          Hay un test que lee el HTML que servimos y falla si aparece.
        </li>
        <li>
          <strong>Cifradas en la base.</strong> Cada dirección se guarda cifrada y
          atada a su propia fila, y se busca por un índice ciego — un resumen con
          clave que permite encontrarla sin guardarla en claro.
        </li>
        <li>
          <strong>Firmas un mensaje, nunca una transacción.</strong> Este sitio no
          custodia fondos ni construye operaciones. Un test falla si el código de
          la aplicación pudiera siquiera importar una API que arme o envíe una.
        </li>
      </ul>
    </>
  );
}
