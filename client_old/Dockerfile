FROM node:18-alpine AS build
WORKDIR /app
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM nginx:stable-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Optional: copy custom nginx conf if exists
EXPOSE 80
CMD [ "nginx", "-g", "daemon off;" ]
