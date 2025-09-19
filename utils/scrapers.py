from __future__ import annotations

import time
from typing import List, Dict
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {"User-Agent": USER_AGENT}


def search_yellowpages(query: str, location: str | None = None, max_pages: int = 1) -> List[Dict[str, str]]:
    base = "https://www.yellowpages.com/search"
    results: List[Dict[str, str]] = []
    for page in range(1, max_pages + 1):
        params = {"search_terms": query}
        if location:
            params["geo_location_terms"] = location
        if page > 1:
            params["page"] = str(page)
        try:
            resp = requests.get(base, params=params, timeout=6, headers=HEADERS)
            if resp.status_code >= 400:
                continue
            soup = BeautifulSoup(resp.text, "lxml")
            for li in soup.select(".result"):
                a = li.select_one("a.business-name")
                if not a:
                    continue
                name = a.get_text(strip=True)
                href = a.get("href") or ""
                if not href:
                    continue
                url = href if href.startswith("http") else urljoin("https://www.yellowpages.com", href)
                results.append({"title": name, "url": url, "source": "yellowpages"})
        except Exception:
            continue
        time.sleep(0.2)
    return results


def search_bbb(query: str, location: str | None = None, max_pages: int = 1) -> List[Dict[str, str]]:
    base = "https://www.bbb.org/search"
    results: List[Dict[str, str]] = []
    params = {"find_text": query}
    if location:
        params["find_loc"] = location
    try:
        resp = requests.get(base, params=params, timeout=6, headers=HEADERS)
        if resp.status_code >= 400:
            return results
        soup = BeautifulSoup(resp.text, "lxml")
        for a in soup.select("a.Link__Anchor-sc-19vsptk-0")[:50]:
            name = a.get_text(strip=True)
            href = a.get("href") or ""
            if not href or "/profile/" not in href:
                continue
            url = href if href.startswith("http") else urljoin("https://www.bbb.org", href)
            results.append({"title": name, "url": url, "source": "bbb"})
    except Exception:
        return results
    return results


def search_manta(query: str, location: str | None = None, max_pages: int = 1) -> List[Dict[str, str]]:
    base = "https://www.manta.com/search"
    results: List[Dict[str, str]] = []
    params = {"search": query}
    if location:
        params["search_location"] = location
    try:
        resp = requests.get(base, params=params, timeout=6, headers=HEADERS)
        if resp.status_code >= 400:
            return results
        soup = BeautifulSoup(resp.text, "lxml")
        for a in soup.select("a.card__title")[:50]:
            name = a.get_text(strip=True)
            href = a.get("href") or ""
            if not href:
                continue
            url = href if href.startswith("http") else urljoin("https://www.manta.com", href)
            results.append({"title": name, "url": url, "source": "manta"})
    except Exception:
        return results
    return results
