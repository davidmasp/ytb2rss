

from flask import Flask, request, render_template

import pdb
import requests
from bs4 import BeautifulSoup
import time

def get_rss_from_channel_name(channel_name):
    html = get_html_from_channel_name(channel_name)
    rss_url = extract_rss_url(html)
    return rss_url

def get_html_from_channel_name(channel_name):
    base_url = "https://www.youtube.com/{}"
    url = base_url.format(channel_name)
    response = requests.get(url)
    if response.ok:
        return response.text
    else:
        raise Exception(f"Bad response: {response.status_code}")
    
def extract_rss_url(html):
    # Parse the HTML with BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')
    # Find the link tag with the RSS URL
    rss_link = soup.find('link', type='application/rss+xml')
    # Extract the href attribute from the link tag
    rss_url = rss_link['href']
    return rss_url

def get_channels_rss(text):
    all_channel_names = text.split('\r\n')
    output = []
    for channel_name in all_channel_names:
        time.sleep(.1)
        html = get_html_from_channel_name(channel_name)
        rss_url = extract_rss_url(html)
        obj = {
            "name": channel_name,
            "rss": rss_url
        }
        output.append(obj)
    return output

app = Flask(__name__)

@app.route('/', methods=['GET', 'POST'])
def home():
    if request.method == 'POST':
        text = request.form.get('text')
        result = get_channels_rss(text)
        return render_template('index.html', result=result)
    return render_template('index.html')

if __name__ == '__main__':
    app.run(debug=True)