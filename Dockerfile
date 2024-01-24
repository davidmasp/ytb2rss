FROM python:3.12.1-slim-bullseye

WORKDIR /app

ADD . /app

RUN pip install --no-cache-dir pip-tools
RUN pip-compile requirements.in
RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 5000

CMD ["python", "app.py"]
