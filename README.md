# PF2e Simple Weapon Editor

Un editor de armas, **armaduras y escudos** para **Foundry VTT** con el sistema **Pathfinder 2e**: todo lo que un GM quiere tocar de su equipo —daño, defensas, runas, rasgos y efectos según quién lo porte— en una sola ventana, sin editar JSON ni pelearse con rule elements. Y lo que se configura, **se resuelve solo en mesa**: salvaciones, curaciones y condiciones se tiran y aplican automáticamente.

*A weapon, armor and shield editor for Foundry VTT (PF2e): damage, defenses, runes, traits and wielder-dependent effects in one window, with automatic at-the-table resolution of saves and healing. UI available in English and Spanish.*

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

## 🛡️ Armaduras y escudos

El mismo botón **Editar** aparece en las fichas de armaduras y escudos, con su propio editor:

- **Defensa**: categoría, grupo, bonificador a la CA, tope de Destreza, penalizaciones a pruebas y velocidad, y Fuerza requerida (armaduras); CA, Dureza, PV y penalización de velocidad (escudos). Una vista previa muestra lo que calculará el sistema —qué anula la Fuerza, la resistencia de especialización del grupo, los valores efectivos de un escudo con runa de refuerzo o material precioso.
- **Resistencias, debilidades e inmunidades** con los tipos del sistema, valor fijo, igual al nivel o a la mitad del nivel, y excepciones.
- **Modificadores defensivos** tipados a la CA, salvaciones, Percepción, habilidades o velocidad, opcionalmente solo **contra cuerpo a cuerpo, a distancia o conjuros**. En escudos, cualquier fila puede exigir el **escudo alzado**.
- **Runas**: potencia, resiliente y runas de propiedad como fichas con nivel, precio y descripción (armaduras); runa de refuerzo (escudos).
- **Runas de propiedad que funcionan**: PF2e no automatiza sus efectos, así que el módulo se encarga de 56 de las 73. A 42 les agrega reglas —la resistencia de *Acid-Resistant* y compañía, el +1 de *Slick* al Escapar, el tipo a elegir de *Energy Adaptive* desde la pestaña Acciones…— y las que reaccionan a algo en mesa las resuelve su motor: *Fortification*, *Dread*, *Unnerving*, *Bitter* y el recordatorio de *Advancing*; y las que son una reacción a elección del jugador —*Swallow-Spike*, *Deathless*, la reacción de *Energy Adaptive* y *Spellwatch*— le preguntan con un botón en el chat. Cada ficha dice si la runa está automatizada, en parte o queda manual, y la automatización se puede apagar runa por runa.
- **Condiciones por portador**: las mismas que en las armas —ascendencia, herencia, clase, dote o estado de quien la lleva— más una propia de la defensa: que **el atacante** sufra un estado (por ejemplo, +2 a la CA contra un atacante asustado). El efecto puede ser un modificador defensivo, una resistencia, debilidad o inmunidad, curación o **PV temporales al inicio del turno**.
- **Reacciones**: efectos que se disparan solos **al recibir un golpe, un crítico o daño**, o (escudos) **al Bloquear con el escudo**, filtrados por tipo de ataque (cuerpo a cuerpo, sin alcance, adyacente…). Pueden hacerle **daño al atacante** (espinas; con dados, tipo, persistente o igual a la Dureza del escudo), poner un **estado** al atacante o al portador, o dar **PV temporales**; con salvación opcional (CD fija o del portador), frecuencia (1/turno, 1/ronda, 1/hora, 1/día…) y requisitos. Cada tarjeta puede marcarse **"preguntar"**: en vez de aplicarse sola, ofrece **Usar / Rechazar** en el chat al dueño del portador y al GM.
- **Fortificación**: una CD de prueba plana propia, además de las runas *Fortification* (CD 17) y *Greater Fortification* (CD 14).
- **Rasgos** de armadura o de escudo, con buscador y frecuentes.

Las reglas de una armadura solo valen con la armadura **puesta en su ranura, e investida si es mágica** —así funciona PF2e, y el editor lo avisa—. Las reglas de cada runa solo actúan mientras la runa está en la armadura y tiene ranura: si se quita desde la hoja del sistema, o se baja la potencia, sus efectos se apagan solos.

## Automatización en mesa

Lo configurado no se queda en la ficha — el módulo lo resuelve durante el juego:

- **Salvaciones automáticas**: al tirarse el daño de un golpe que conectó, cada pieza con salvación se resuelve sola — el **objetivo** tira su estadística contra la CD (la del portador se calcula en ese instante), y el daño se aplica según el grado de éxito: completo si falla, **doble en fallo crítico**, mitad o nada si salva, y **doble adicional si el golpe fue crítico**. Se aplica como daño tipado, así que **inmunidades, resistencias y debilidades cuentan**, y el resumen dice cuánto se recibió de verdad.
- **Una sola vez por ataque**: tirar *Damage* y luego *Critical*, o un reroll con punto de héroe, no repite los efectos; y pulsar *Damage* sobre un ataque fallado no dispara nada.
- **Persistentes con salvación** se aplican como la **condición real** del sistema (con su tirada plana de recuperación), no como HP crudo.
- **Un solo resumen en el chat** por golpe — estadística, d20 contra la CD, grado y resultado de cada pieza — en vez de una carta por tirada. Con Dice So Nice, los dados igual se animan.
- El daño con salvación **no aparece en la tirada principal** (es independiente, como los riders de conjuro); su nota en la carta de daño, titulada *"Salvación aparte"*, trae los botones `@Check` y `@Damage` para la vía manual — útil para los adyacentes de una salpicadura.
- **Curaciones por portador** con tirada visible, aplicadas una sola vez aunque el mundo tenga dos GMs conectados, y silenciosas cuando el portador ya está a tope de vida.
- **Reacciones de armaduras y escudos**: los golpes y críticos se resuelven cuando el atacante tira el daño contra el portador (debe marcarlo como objetivo); "al recibir daño" y los de escudo, cuando el daño se aplica. Un solo resumen por golpe, sin repetirse con *Damage* y *Critical*, y sin rebotes entre dos portadores de espinas.
- **Reacciones a elección**: el botón **Usar** del jugador llega al GM conectado y se aplica una sola vez; la pregunta caduca cuando pasa el turno (o a los 2 minutos fuera de combate). *Swallow-Spike* ataca a quien te agarra o engulle (suma la runa de potencia, y el crítico hace doble daño); *Deathless* baja en 1 un condenado o herido nuevo (1/día); *Energy Adaptive* cambia su resistencia al tipo de energía que acabás de recibir (1/hora); *Spellwatch* ofrece al inicio de tu turno repetir la salvación contra un conjuro enemigo. Las CD y la CA de los PNJ se ocultan a los jugadores, como en PF2e.
- **Fortificación**: ante un crítico contra el portador, el GM tira la prueba plana a la vista; si sale, la tarjeta del ataque pasa a **golpe** y el botón *Critical* queda bloqueado para los jugadores (el GM puede forzarlo). El jugador puede gastar un punto de héroe en su prueba.
- **Dread**: al final del turno de un enemigo asustado a 30 pies que ve al portador, se tira su Voluntad; si falla, su asustado no baja del mínimo de la runa, lo baje quien lo baje. **Unnerving** deja −1 a su siguiente Golpe cuerpo a cuerpo contra el portador, y se consume solo.

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
