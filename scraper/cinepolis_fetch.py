#!/usr/bin/env python3
"""
Cliente de la API de Cinépolis (GraphQL en api-g.cinepolis.com).

Existe como proceso Python aparte —y no dentro del bot de Node— por una sola
razón: Cloudflare bloquea a Cinépolis por *fingerprint TLS*, no por cabeceras.
`fetch` de Node y `curl` normal reciben 403 aunque manden el User-Agent y el
Origin correctos; `curl_cffi` imita el handshake TLS de Chrome y pasa. El bot
lo invoca como subproceso y lee JSON por stdout.

Uso:
  cinepolis_fetch.py snapshot      → catálogo nacional + qué se vende en CDMX
  cinepolis_fetch.py showtimes <movieId> → funciones reales en cines de CDMX
  cinepolis_fetch.py showtimes-cinema <movieId> <cinemaId,cinemaId,...>
    → funciones reales, restringidas a cines concretos (sin el corte de 40)

La API key es la del bundle público del sitio (está en el JS que sirve
cinepolis.com a cualquier visitante); no hay credenciales de usuario aquí.
"""
import json
import os
import sys
from dotenv import load_dotenv

from curl_cffi import requests
load_dotenv()
API_KEY = os.getenv("CINEPOLIS_API_KEY")
if not API_KEY:
    raise ValueError("CINEPOLIS_API_KEY no está definida en .env")

BILLBOARDS = "https://api-g.cinepolis.com/v2/billboards/graphql"
LOCATIONS = "https://api-g.cinepolis.com/shared-services/locations/graphql"
HEADERS = {
  "x-apikey": API_KEY,
  "content-type": "application/json",
  "origin": "https://cinepolis.com",
  "referer": "https://cinepolis.com/",
}
# El país va en MAYÚSCULAS: con "mx" la API responde INTERNAL_ERROR.
COUNTRY = "MX"
CITY = "cdmx"
TZ = "America/Mexico_City"
# La query billboard rechaza más de 30 cines por llamada (error 105).
CINEMA_BATCH = 30
TIMEOUT = 45

MOVIES_Q = """
query M($countryId: String!, $cinemas: String, $limit: Int) {
 movies(countryId: $countryId, cinemas: $cinemas, limit: $limit) {
  totalCount
  edges { node {
   id name originalName releaseDate availableForSale categories
   genre length rating formats languages
  } }
 }
}"""

CITIES_Q = """
query C($countryId: String!) {
 cities(country_id: $countryId) {
  edges { node { id name cinemas { id vistaId name } } }
 }
}"""

BILLBOARD_Q = """
query B($countryId: String!, $movieId: String!, $cinemas: String!, $timezone: String) {
 billboard(countryId: $countryId, movieId: $movieId, cinemas: $cinemas, timezone: $timezone) {
  dates
  schedules { cinemaId dates { date languages { language displayLanguage
   showtimes { sessionId datetime availability screen format { name } } } } }
 }
}"""


def gql(url, query, variables):
  res = requests.post(
    url,
    headers=HEADERS,
    json={"query": query, "variables": variables},
    impersonate="chrome",
    timeout=TIMEOUT,
  )
  if res.status_code != 200:
    raise RuntimeError(f"HTTP {res.status_code} en {url}")
  body = res.json()
  if body.get("errors"):
    raise RuntimeError(body["errors"][0].get("message", "error de GraphQL"))
  return body["data"]


def cdmx_cinemas():
  data = gql(LOCATIONS, CITIES_Q, {"countryId": COUNTRY})
  for edge in data["cities"]["edges"]:
    if edge["node"]["id"] == CITY:
      return edge["node"]["cinemas"]
  raise RuntimeError(f"La ciudad {CITY} no aparece en el catálogo de Cinépolis")


def movies(cinemas_csv=None):
  variables = {"countryId": COUNTRY, "limit": 400}
  if cinemas_csv:
    variables["cinemas"] = cinemas_csv
  data = gql(BILLBOARDS, MOVIES_Q, variables)
  return [e["node"] for e in data["movies"]["edges"]]


def snapshot():
  """
  Catálogo nacional + el subconjunto que de verdad tiene cines en CDMX.

  Son dos señales distintas y las dos importan: el catálogo nacional es donde
  una película aparece primero (como 'coming-soon', antes de tener funciones),
  y el filtro por cines de CDMX es lo que confirma que aquí ya se puede comprar.
  """
  cinemas = cdmx_cinemas()
  national = movies()
  ids_cdmx = {m["id"] for m in movies(",".join(c["id"] for c in cinemas))}
  out = []
  for m in national:
    cats = m.get("categories") or []
    out.append({
      "chain": "Cinépolis",
      "id": m["id"],
      "title": m["name"],
      "originalTitle": m.get("originalName") or "",
      "releaseDate": (m.get("releaseDate") or "")[:10],
      "categories": cats,
      "presale": "pre-sale" in cats,
      "comingSoon": cats == ["coming-soon"],
      "availableForSale": bool(m.get("availableForSale")),
      "inCdmx": m["id"] in ids_cdmx,
      "url": f"https://cinepolis.com/mx/detalle/{m['id']}",
    })
  return {"chain": "Cinépolis", "cinemasCdmx": len(cinemas), "movies": out}


def _sessions_for(movie_id, cinemas):
  """Funciones reales para una lista concreta de cines. Sin truncar: quien
  llama decide si le hace falta un tope."""
  by_id = {c["id"]: c["name"] for c in cinemas}
  dates, sessions = set(), []
  for i in range(0, len(cinemas), CINEMA_BATCH):
    csv = ",".join(c["id"] for c in cinemas[i:i + CINEMA_BATCH])
    data = gql(BILLBOARDS, BILLBOARD_Q, {
      "countryId": COUNTRY, "movieId": movie_id, "cinemas": csv, "timezone": TZ,
    })
    board = data.get("billboard") or {}
    for schedule in board.get("schedules") or []:
      for day in schedule["dates"]:
        dates.add(day["date"])
        for lang in day["languages"]:
          for show in lang["showtimes"]:
            sessions.append({
              "cinema": by_id.get(schedule["cinemaId"], schedule["cinemaId"]),
              "cinemaId": schedule["cinemaId"],
              "date": day["date"],
              "datetime": show["datetime"],
              "language": lang.get("displayLanguage") or lang.get("language"),
              "format": (show.get("format") or {}).get("name") or "",
              "sessionId": show["sessionId"],
            })
  sessions.sort(key=lambda s: s["datetime"])
  return dates, sessions


def showtimes(movie_id):
  cinemas = cdmx_cinemas()
  dates, sessions = _sessions_for(movie_id, cinemas)
  return {
    "chain": "Cinépolis",
    "movieId": movie_id,
    "dates": sorted(dates),
    "cinemas": len({s["cinema"] for s in sessions}),
    "count": len(sessions),
    # Corte a 40: esto es para mostrar en Telegram, no para decidir si una
    # función concreta existe. Por eso showtimes_for_cinemas() no trunca —
    # con 87 cines en CDMX, una función de un cine puntual podría quedar
    # fuera de las 40 más tempranas de toda la ciudad aunque ya esté publicada.
    "sessions": sessions[:40],
    "url": f"https://cinepolis.com/mx/detalle/{movie_id}",
  }


def showtimes_for_cinemas(movie_id, cinema_ids):
  """
  Como showtimes(), pero restringido a una lista concreta de cines (por su
  slug de cinemaId), sin el corte de 40. Existe para el flash-assist de Plaza
  Carso: necesita saber con certeza si ESE cine ya tiene función, no una
  muestra de las funciones más tempranas de toda CDMX.
  """
  all_cinemas = cdmx_cinemas()
  wanted = set(cinema_ids)
  cinemas = [c for c in all_cinemas if c["id"] in wanted]
  if not cinemas:
    raise RuntimeError(f"Ninguno de los cines {cinema_ids} está en el catálogo de CDMX")
  dates, sessions = _sessions_for(movie_id, cinemas)
  return {
    "chain": "Cinépolis",
    "movieId": movie_id,
    "dates": sorted(dates),
    "cinemas": len({s["cinema"] for s in sessions}),
    "count": len(sessions),
    "sessions": sessions,
    "url": f"https://cinepolis.com/mx/detalle/{movie_id}",
  }


def main():
  try:
    command = sys.argv[1] if len(sys.argv) > 1 else "snapshot"
    if command == "snapshot":
      result = snapshot()
    elif command == "showtimes":
      result = showtimes(sys.argv[2])
    elif command == "showtimes-cinema":
      result = showtimes_for_cinemas(sys.argv[2], sys.argv[3].split(","))
    else:
      raise RuntimeError(f"Comando desconocido: {command}")
  except Exception as err: # el bot distingue el fallo por la clave "error"
    json.dump({"error": str(err)}, sys.stdout, ensure_ascii=False)
    sys.exit(1)
  json.dump(result, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
  main()
