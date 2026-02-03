FROM node:22-slim

# Install ffmpeg, python, yt-dlp, and fonts
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    fonts-liberation \
    fonts-dejavu-core \
    fontconfig \
    && pip3 install --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Download Google Fonts for text overlays
RUN mkdir -p /usr/share/fonts/googlefonts && \
    cd /usr/share/fonts/googlefonts && \
    curl -sL "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-Bold.ttf" -o Poppins-Bold.ttf && \
    curl -sL "https://github.com/google/fonts/raw/main/ofl/poppins/Poppins-SemiBold.ttf" -o Poppins-SemiBold.ttf && \
    curl -sL "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat-Bold.ttf" -o Montserrat-Bold.ttf && \
    curl -sL "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay-Bold.ttf" -o PlayfairDisplay-Bold.ttf && \
    curl -sL "https://github.com/google/fonts/raw/main/ofl/dancingscript/DancingScript-Bold.ttf" -o DancingScript-Bold.ttf && \
    curl -sL "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf" -o BebasNeue-Regular.ttf && \
    curl -sL "https://github.com/google/fonts/raw/main/ofl/oswald/Oswald-Bold.ttf" -o Oswald-Bold.ttf && \
    curl -sL "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf" -o Anton-Regular.ttf && \
    fc-cache -fv

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
