import express from "express";
import { ChromaDestination } from "./lib/destinations/chroma";
import { PrismaDestination } from "./lib/destinations/prisma";
import { S3Destination } from "./lib/destinations/s3";
import { SupagluePaginator } from "./lib/supaglue_paginator";
import { WatermarkManager } from "./lib/watermark_manager";

const app = express();
app.use(express.json());
const port = process.env.PORT || 3030;
const { IS_INCREMENTAL = "true" } = process.env;

// Persist this for the duration that the server is running.
const watermarkManager = new WatermarkManager();
const paginators: SupagluePaginator[] = [];

const supportedCommonModels = [
  "account",
  "contact",
  "lead",
  "opportunity",
  "user",
];

const commonModelToObjectListName: Record<string, string> = {
  account: "accounts",
  contact: "contacts",
  lead: "leads",
  opportunity: "opportunities",
  user: "users",
};

app.post("/supaglue_sync_webhook", async (req, res) => {
  console.log("incoming event", {
    type: req.body?.type,
    payload: req.body?.payload,
  });
  if (
    req.body.type !== "SYNC_SUCCESS" ||
    !req.body?.payload?.customer_id ||
    !req.body?.payload?.provider_name ||
    !req.body?.payload?.common_model
  ) {
    return res
      .status(200)
      .send(
        "not a sync success event or no customer_id/provider_name/common_model"
      );
  }

  const customerId = req.body.payload.customer_id;
  const providerName = req.body.payload.provider_name;
  const commonModel = req.body.payload.common_model;

  if (!supportedCommonModels.includes(commonModel)) {
    console.log("sync event for object type not supported", commonModel);
    return res.status(200).send("sync event for object type not supported");
  }

  const objectListName = commonModelToObjectListName[commonModel];

  // Check to see if we're already syncing this object/customer/provider
  const existingPaginator = paginators.find((paginator) => {
    return (
      paginator.objectListName === objectListName &&
      paginator.customerId === customerId &&
      paginator.providerName === providerName
    );
  });

  if (existingPaginator) {
    console.log("already syncing", objectListName, customerId, providerName);
    return res.status(200).send("already syncing");
  }

  // Start syncing this object type
  const syncStartTime = new Date();

  function createDestination(name: string) {
    switch (name) {
      case "s3":
        return new S3Destination(
          objectListName,
          customerId,
          providerName,
          syncStartTime
        );
      case "chroma":
        return new ChromaDestination(
          objectListName,
          customerId,
          providerName,
          syncStartTime
        );
      case "postgres":
        return new PrismaDestination(objectListName, syncStartTime);
    }

    return new PrismaDestination(objectListName, syncStartTime);
  }

  const supagluePaginator = new SupagluePaginator({
    objectListName,
    customerId,
    providerName,
    destination: createDestination(process.env.DESTINATION!),
    incremental: IS_INCREMENTAL === "true" || IS_INCREMENTAL === "1",
    watermarkManager,
  });

  paginators.push(supagluePaginator);

  supagluePaginator
    .start()
    .catch((err) => {
      console.error("error syncing", objectListName, err);
    })
    .finally(() => {
      // Clean up when done
      paginators.splice(paginators.indexOf(supagluePaginator), 1);
    });

  return res.send("ok");
});

app.get("/healthz", (req, res) => {
  return res.send("ok");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
