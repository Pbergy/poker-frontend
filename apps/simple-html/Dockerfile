FROM node:20-alpine
WORKDIR /app
COPY public .
RUN npm install -g http-server
EXPOSE 3000
CMD ["http-server", ".", "-a", "0.0.0.0", "-p", "3000", "-c-1"]


