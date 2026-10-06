# PF2e Simple Weapon Editor

Un editor de armas para **Foundry VTT** con el sistema **Pathfinder 2e**: todo lo que un GM quiere tocar de un arma —daño, runas, rasgos y efectos según quién la porte— en una sola ventana, sin editar JSON ni pelearse con rule elements. Y lo que se configura, **se resuelve solo en mesa**: salvaciones, curaciones y condiciones se tiran y aplican automáticamente.

*A weapon editor for Foundry VTT (PF2e): damage, runes, traits and wielder-dependent effects in one window, with automatic at-the-table resolution of saves and healing. UI available in English and Spanish.*

## Instalación

En Foundry: **Add-on Modules → Install Module** y pegar la URL del manifiesto:

```
https://github.com/BaronHVC/pf2e-simple-weapon-editor/releases/latest/download/module.json
```

Las actualizaciones estables llegan solas por el botón Update de Foundry.

## Qué hace

El editor se abre desde el arma y organiza todo en cuatro pestañas:

### 🩸 Daño

- **Base**: dados, tipo (cada tipo con su ícono y color) y **salpicadura nativa** — al ponerle valor, el trait `splash` se agrega solo. La nota de striking dice la verdad: si fijás los dados a mano, avisa que la runa no los cambia.
- **Daño extra**: filas con dado o cantidad fija, tipo (incluido **precisión**, que se suma al tipo base del arma como en el sistema) y fuente descriptiva.
- **Daño a elegir**: las filas marcadas con ✋ no se aplican siempre — antes de **cada ataque** aparece una ventana donde el jugador marca cuáles sumar (una, varias o ninguna). Se recuerda la última elección, *Cancelar* anula el ataque, y cada golpe conserva su propia elección aunque los daños se tiren fuera de orden.
- **Salpicadura con bloque propio**: cantidades y tipos independientes del daño base, que se tiran como las bombas de verdad (partial separada para los adyacentes, sin duplicarse en críticos).
- **Persistente**: daño recurrente por ronda, con la primera entrada en el campo nativo del sistema.
- **Salvaciones por entrada**: cualquier daño extra, de salpicadura o persistente puede exigir una salvación para resistirlo — Fortaleza, Reflejos, Voluntad, Percepción o cualquier habilidad, con **CD fija o la CD del portador** (su CD de hechizos, o la de clase si no tiene), y resultado configurable: mitad o nada al salvar.
- **Estados al golpear**: el golpe puede imponer cualquiera de las condiciones del sistema (frightened 2, clumsy, quickened…) **al objetivo o al portador**, positivas o negativas, siempre o detrás de una salvación — que se aplique si falla, o solo con fallo crítico.
- Las **condiciones de daño por portador** aparecen espejadas aquí como filas bloqueadas con su motivo — la pestaña muestra el cuadro completo del arma.
- Vista previa coloreada de la fórmula final.

### ✨ Runas

Potencia, striking y runas de propiedad como fichas con **nivel, precio y descripción expandible** (leídos del compendio). El límite de runas por potencia se respeta, con **modo libre de GM** para saltárselo a consciencia. El precio total del arma es editable, con piso automático en el valor de las runas.

### 🏷️ Rasgos

Chips con buscador y accesos rápidos a los rasgos frecuentes. Admite rasgos custom.

### 👥 Condiciones por portador

Efectos que solo se activan bajo ciertas circunstancias. Los requisitos se combinan con "y":

- **Quién lleva el arma**: su ascendencia, herencia, clase o dote. Entiende *Adopted Ancestry*: una ascendencia adoptada cuenta para las condiciones de ascendencia.
- **Estados alterados**: que **el portador** o **el objetivo** sufra una condición, con valor mínimo opcional (por ejemplo *frightened 2 o más*).
- **MAP**: que el portador esté atacando con penalización por ataques múltiples.

Y el efecto puede ser **daño extra**, **curación al golpear**, **curación al inicio del turno**, o un **modificador a la tirada de ataque** con el tipo que elija el GM (circunstancial, de estatus, de objeto o sin tipo) — negativo para penalizaciones.

## Automatización en mesa

Lo configurado no se queda en la ficha — el módulo lo resuelve durante el juego:

- **Salvaciones automáticas**: al tirarse el daño de un golpe que conectó, cada pieza con salvación se resuelve sola — el **objetivo** tira su estadística contra la CD (la del portador se calcula en ese instante), y el daño se aplica según el grado de éxito: completo si falla, **doble en fallo crítico**, mitad o nada si salva, y **doble adicional si el golpe fue crítico**. Se aplica como daño tipado, así que **inmunidades, resistencias y debilidades cuentan**, y el resumen dice cuánto se recibió de verdad.
- **Una sola vez por ataque**: tirar *Damage* y luego *Critical*, o un reroll con punto de héroe, no repite los efectos; y pulsar *Damage* sobre un ataque fallado no dispara nada.
- **Persistentes con salvación** se aplican como la **condición real** del sistema (con su tirada plana de recuperación), no como HP crudo.
- **Un solo resumen en el chat** por golpe — estadística, d20 contra la CD, grado y resultado de cada pieza — en vez de una carta por tirada. Con Dice So Nice, los dados igual se animan.
- El daño con salvación **no aparece en la tirada principal** (es independiente, como los riders de conjuro); su nota en la carta de daño, titulada *"Salvación aparte"*, trae los botones `@Check` y `@Damage` para la vía manual — útil para los adyacentes de una salpicadura.
- **Curaciones por portador** con tirada visible, aplicadas una sola vez aunque el mundo tenga dos GMs conectados, y silenciosas cuando el portador ya está a tope de vida.

## Compatibilidad

- Foundry VTT **v13–v14** · sistema **PF2e 7.0+**
- Interfaz en **español e inglés**
- Ajuste "Solo GM" para permitir (o no) que los jugadores dueños de un arma abran el editor

## Para probar versiones en desarrollo

Canal de pruebas con URL fija (se reemplaza en cada build, estable o rc):

```
https://github.com/BaronHVC/pf2e-simple-weapon-editor/releases/download/dev/module.json
```

---

Hecho por Carlos Eduardo + Claude, para la mesa de Astura.
