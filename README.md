# Telinha Café

Compartilhamento de tela e câmera entre amigos (até 6 pessoas), direto P2P via WebRTC. Um app do **Fate Café**.

☕ **[Apoie o Fate Café!](https://livepix.gg/fatecafe)** (Pix pelo LivePix)

## Baixar
Última versão em **[Releases](https://github.com/ThiagoKrz/TelinhaCafe/releases/latest)**.

## Instalar
- **`TelinhaCafe-Setup-1.3.0.exe`** (recomendado): instala só pro seu usuário (não pede administrador),
  cria atalho na área de trabalho e no menu Iniciar. Pra atualizar, é só rodar o instalador da versão nova por cima.
- **`TelinhaCafe-1.3.0-portatil.exe`**: roda sem instalar (demora uns segundos a mais pra abrir).
- **`TelinhaCafe-1.3.0.apk`** (Android 7+): entra nas mesmas salas do PC. Ao instalar, permita "instalar apps de
  fontes desconhecidas".
- Na 1ª vez o Windows pode mostrar "O Windows protegeu o computador" → **Mais informações → Executar assim mesmo**
  (o app não é assinado).
- **Todo mundo da sala precisa da mesma versão.** Se não for, o app avisa quem precisa atualizar.

## Como usar
1. Um cria a sala e passa o **código de 6 letras**; os outros clicam em **Entrar** com o código.
2. Qualquer um pode ligar **tela** e/ou **câmera**. Por padrão você vê todo mundo.
3. Em cada vídeo: volume, destacar, tela cheia, janela flutuante e **✕ tirar da tela**. Ao tirar, a pessoa
   para de te mandar aquele vídeo (economiza internet e PC); ele fica numa barra em cima pra "mostrar" de novo.
4. Compartilhando, o botão **Trocar** muda a tela/janela/áudio sem derrubar a transmissão.

### 📱 No Android
- Entra nas mesmas salas de quem está no PC (mesmo código).
- Assistir tela e câmera, ligar a câmera do celular, chat, reações, foto, desenhar com o dedo.
- **Controlar o PC pelo celular**: tocar = clique, segurar = botão direito, arrastar = arrastar, dois dedos = rolar,
  e o botão ⌨ abre o teclado (digita no PC, com acentos no padrão ABNT2).
- Ainda não dá pra compartilhar a tela do celular (próxima fase).

### Áudio da tela
- **Som do PC, sem o Discord**: todo o som do PC menos o Discord (sem eco na call).
- **Só o som de…**: um app específico (Spotify, jogo, navegador…) ou só o da janela que você está compartilhando.
- **Som do PC completo**: inclui o Discord (quem está na call ouve eco).
- **Sem áudio**.
As duas primeiras precisam de Windows 11 ou Windows 10 atualizado; se não der, aparecem desativadas.

### Ponteiro e desenho
- Quem assiste clica no ✏️ do vídeo: mexer o mouse mostra um ponteiro com o nome, clicar faz um círculo,
  arrastar risca (some sozinho). Botão direito ou Esc sai.
- Quem compartilha liga/desliga isso no ✏️ da barra de cima (ou nas configurações).
- Compartilhando a **tela inteira**, os ponteiros aparecem **por cima da sua tela de verdade** (camada transparente
  que não aparece na transmissão e deixa os cliques passarem). Não aparece por cima de jogos em
  "tela cheia exclusiva"; em "janela sem borda" funciona.

- **Cores**: cada um escolhe a cor do ponteiro e a do desenho (paleta ou qualquer cor) e a espessura
  (fino/médio/grosso), na paletinha que aparece no vídeo com o lápis ativo ou em ⚙ Configurações.

### Controle remoto
- Quem assiste clica no 🖱 do vídeo pra **pedir controle** do mouse e do teclado.
- Quem compartilha precisa **aceitar**: pela janela do app ou, de dentro do jogo, **Ctrl+Alt+Y** (aceita) /
  **Ctrl+Alt+N** (recusa). O pedido também aparece por cima da tela.
- Enquanto alguém controla, um aviso fica por cima da tela. **Ctrl+Alt+X corta na hora**, de qualquer lugar,
  assim como o botão "Parar controle". Quem controla também solta pelo 🖱 ou Ctrl+Alt+X.
- Uma pessoa por vez; acaba sozinho se parar de compartilhar, trocar pra uma janela ou a pessoa sair.
  A tecla Windows é bloqueada.
- Só funciona compartilhando a **tela inteira**. Programas rodando como administrador não aceitam o controle
  (proteção do Windows). Dá pra desligar os pedidos em ⚙ Configurações.

### Host e moderação
- Quem cria a sala é o **host** (a chave fica salva no PC dele). Ele pode sair e voltar pelo botão
  "Voltar pra sala" na tela inicial e recupera os poderes. Se a sala ficou vazia, ela é reaberta com o mesmo código.
- Enquanto o host está fora, a sala continua funcionando e gente nova ainda consegue entrar.
- Clicando no nome de alguém em "Na sala": **proibir de compartilhar** / **remover da sala**.
- Em ⚙ Configurações: **trancar sala**, **só o host compartilha**, desfazer remoções.

### Outros
- Foto de perfil (reduzida pra 128px; quem recebe guarda só na memória enquanto está na sala).
- Reações com emoji, ping de cada pessoa, sons de notificação, FPS/resolução de cada vídeo
  e opção de ocultar a própria prévia pra economizar PC.

## Rede
- A sala usa o servidor público gratuito do PeerJS só pra trocar o código/conexão; o vídeo vai direto entre vocês.
- Se a rede de alguém não deixar conexão direta, o app tenta um servidor de retransmissão (TURN) público de reserva
  e mostra a etiqueta "via servidor". Se mesmo assim não conectar, aparece um aviso no chat.
- Em ⚙ Configurações → Conexão dá pra colocar um servidor TURN próprio (ex.: conta grátis na Metered ou Cloudflare);
  se o host colocar, ele é repassado pra todo mundo da sala.
- Upload: cada pessoa assistindo consome o bitrate da qualidade escolhida (ex.: 1080p60 ≈ 8 Mbps × pessoas).
- O vídeo é codificado em H.264 na placa de vídeo quando disponível (menos CPU) e já começa em alta qualidade.

## Desenvolvimento
```
npm install
npm start          # rodar em modo dev
npm run dist       # gera dist/TelinhaCafe-Setup-x.y.z.exe e dist/TelinhaCafe-x.y.z-portatil.exe
```
Requisitos pra compilar: Node.js 20+ e Windows (o `native/AudioCap.exe` é compilado com o `csc.exe` do .NET Framework
que já vem no Windows).

### Android (pasta `mobile/`)
A interface é a mesma do PC (`src/renderer`), empacotada com Capacitor; `mobile/web/mobile-shim.js` faz o papel do
preload do Electron. Precisa do Android SDK e de um JDK 21+ (`JAVA_HOME`).
```
cd mobile
npm install
npm run apk          # gera android/app/build/outputs/apk/release/app-release.apk (assinado)
npm run apk:debug    # versão de teste (com depuração do WebView)
npm run assets       # regera ícones e tela de abertura a partir do logo
```
A chave de assinatura fica em `mobile/android/telinha-release.jks` + `keystore.properties` (fora do git).
**Guarde uma cópia**: sem ela não dá pra lançar atualização do APK (os amigos teriam que desinstalar).

### Lançar uma versão nova
1. Suba `version` no `package.json` e rode `npm run dist`.
2. `cd mobile && npm run apk` e copie o APK pra `dist/TelinhaCafe-X.Y.Z.apk`.
3. Crie um Release no GitHub com a tag `vX.Y.Z` e anexe o instalador, o portátil e o APK.
- `src/main.js`: processo principal (seletor de tela, capturador de áudio, camada de ponteiros)
- `src/renderer/app.js`: salas, WebRTC em malha, UI
- `src/renderer/annot.js` + `overlay.html`: desenho de ponteiros/riscos
- `native/AudioCap.cs`: captura WASAPI "process loopback" (sem Discord / só um app / só uma janela)
- `build/make-icon.js`: gera o ícone a partir do logo do Fate Café (`npm run build:icon`)
- Visual: cores, botões e fontes (Exo 2 + Open Sans, em `src/renderer/fonts`, licença OFL) seguem o site do Fate Café
- `native/InputCtl.cs`: aplica mouse/teclado do controle remoto (SendInput)
- Ao mudar o protocolo, suba `PROTO` em `app.js`, mas mantenha o formato da porta (`telinha-sala-CODIGO`) e as
  respostas `welcome`/`reject`, pra versões diferentes conseguirem pelo menos avisar "atualize".
