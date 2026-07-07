import express from "express";
import { makeClient, listPipelines, searchOpportunities, updateOpportunity, createOpportunity, searchContacts } from "../ghl.js";
import { listCustomValues } from "../ghl.js"; // Need this to find the dbr_notes custom field
import { getLinkedContacts, addLinkedContact, removeLinkedContact } from "../supabase.js";

// Simple in-memory cache for pipeline resolution (v1)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 mins

export default function createPipelineRouter(getTokenFor) {
  const router = express.Router();

  // Helper to get client
  const getClient = (req) => {
    const loc = req.query.locationId || req.body?.locationId || "";
    if (!loc) throw Object.assign(new Error("missing locationId"), { http: 400 });
    const token = getTokenFor(loc);
    return makeClient(token);
  };

  // 1. Resolve pipeline and stages
  async function resolvePipeline(client, locationId) {
    const cacheKey = `pipeline_${locationId}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

    const pipelines = await listPipelines(client, locationId);
    const dbrPipeline = pipelines.find(p => p.name === "DBR - Reactivation");
    
    if (!dbrPipeline) {
      throw Object.assign(new Error("PIPELINE_NOT_CONFIGURED"), { http: 404 });
    }

    // Ensure all 4 stages exist
    const requiredStages = ["Woke Up", "Talking", "Booked", "Recovered"];
    const stages = [];
    for (const rs of requiredStages) {
      const stage = dbrPipeline.stages.find(s => s.name === rs);
      if (!stage) {
        throw Object.assign(new Error("PIPELINE_NOT_CONFIGURED"), { http: 404 });
      }
      stages.push(stage);
    }

    const result = { pipelineId: dbrPipeline.id, stages };
    cache.set(cacheKey, { ts: Date.now(), data: result });
    return result;
  }

  // Helper: Find custom field ID for dbr_notes
  async function resolveDbrNotesFieldId(client, locationId) {
    const cacheKey = `dbr_notes_${locationId}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.id;

    const cvs = await listCustomValues(client, locationId);
    // Actually, customValues endpoint is for custom values, not custom fields!
    // GHL custom fields for opportunities/contacts might need a different endpoint.
    // Wait, the spec says: "notes maps to an opportunity custom field dbr_notes (created in the snapshot; resolve its custom-field ID by key per location...)"
    // Let's use custom fields endpoint: GET /locations/{locationId}/customFields
    try {
      const res = await client.call(`/locations/${locationId}/customFields`);
      const fields = res.customFields || [];
      const notesField = fields.find(f => f.fieldKey === "opportunity.dbr_notes" || f.fieldKey === "contact.dbr_notes" || f.name === "dbr_notes" || f.fieldKey?.includes("dbr_notes"));
      if (notesField) {
        cache.set(cacheKey, { ts: Date.now(), id: notesField.id });
        return notesField.id;
      }
    } catch (e) {
      console.error("Failed to fetch custom fields", e.message);
    }
    return null;
  }

  // GET /api/pipeline/stages
  router.get("/stages", async (req, res) => {
    try {
      const locationId = req.query.locationId;
      const client = getClient(req);
      const data = await resolvePipeline(client, locationId);
      res.json(data);
    } catch (err) {
      res.status(err.http || 500).json({ error: err.message });
    }
  });

  // GET /api/pipeline/board
  router.get("/board", async (req, res) => {
    try {
      const locationId = req.query.locationId;
      const client = getClient(req);
      const { pipelineId, stages } = await resolvePipeline(client, locationId);

      const columns = [];
      let recoveredTotal = 0;
      let recoveredCount = 0;
      let bookedCount = 0;

      // Map through stages and fetch the first page for each
      for (const stage of stages) {
        const searchRes = await searchOpportunities(client, {
          locationId,
          pipelineId,
          pipelineStageId: stage.id,
          limit: 20,
          page: 1
        });
        
        const opps = searchRes.opportunities || [];
        const totalInStage = searchRes.meta?.total || opps.length;

        // If this is the "Recovered" stage, we must paginate to get the true sum
        if (stage.name === "Recovered") {
          recoveredCount = totalInStage;
          let currentOpps = opps;
          let currentPage = 1;
          
          while (currentOpps.length > 0) {
            for (const o of currentOpps) {
              recoveredTotal += (o.monetaryValue || 0);
            }
            if (currentOpps.length < 20) break; // Reached end
            currentPage++;
            const nextRes = await searchOpportunities(client, {
              locationId, pipelineId, pipelineStageId: stage.id, limit: 20, page: currentPage
            });
            currentOpps = nextRes.opportunities || [];
          }
        }

        if (stage.name === "Booked") {
          bookedCount = totalInStage;
        }

        columns.push({
          stageId: stage.id,
          stageName: stage.name,
          total: totalInStage,
          cards: opps.map(mapOpportunity)
        });
      }

      res.json({
        summary: {
          recoveredTotal,
          recoveredCount,
          bookedCount,
          periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0] // Beginning of month as placeholder
        },
        columns
      });
    } catch (err) {
      res.status(err.http || 500).json({ error: err.message });
    }
  });

  // GET /api/pipeline/column
  router.get("/column", async (req, res) => {
    try {
      const { locationId, stageId, page } = req.query;
      const client = getClient(req);
      const { pipelineId } = await resolvePipeline(client, locationId);

      const searchRes = await searchOpportunities(client, {
        locationId,
        pipelineId,
        pipelineStageId: stageId,
        limit: 20,
        page: parseInt(page) || 1
      });

      res.json({
        stageId,
        total: searchRes.meta?.total || 0,
        cards: (searchRes.opportunities || []).map(mapOpportunity)
      });
    } catch (err) {
      res.status(err.http || 500).json({ error: err.message });
    }
  });

  // GET /api/pipeline/opportunity/:id/contacts
  router.get("/opportunity/:id/contacts", async (req, res) => {
    try {
      const contacts = await getLinkedContacts(req.params.id);
      res.json(contacts);
    } catch (err) {
      console.error("GET linked contacts error", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pipeline/opportunity/:id/contacts
  router.post("/opportunity/:id/contacts", async (req, res) => {
    try {
      const { contact } = req.body;
      if (!contact || !contact.id) throw new Error("Missing contact object");
      await addLinkedContact(req.params.id, contact);
      res.json({ success: true });
    } catch (err) {
      console.error("POST link contact error", err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/pipeline/opportunity/:id/contacts/:contactId
  router.delete("/opportunity/:id/contacts/:contactId", async (req, res) => {
    try {
      await removeLinkedContact(req.params.id, req.params.contactId);
      res.json({ success: true });
    } catch (err) {
      console.error("DELETE link contact error", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/pipeline/opportunity
  router.post("/opportunity", async (req, res) => {
    try {
      const locationId = req.query.locationId;
      const client = getClient(req);
      const { stageId, monetaryValue, notes, contactId, name } = req.body;
      
      const { pipelineId } = await resolvePipeline(client, locationId);
      
      const payload = {
        locationId,
        pipelineId,
        pipelineStageId: stageId,
        contactId,
        name: name || "New Opportunity",
        monetaryValue: typeof monetaryValue === "number" ? monetaryValue : 0,
      };

      if (notes !== undefined) {
        const notesFieldId = await resolveDbrNotesFieldId(client, locationId);
        if (notesFieldId) {
          payload.customFields = [{ id: notesFieldId, field_value: notes }];
        }
      }

      const created = await createOpportunity(client, payload);
      res.json(mapOpportunity(created));
    } catch (err) {
      console.error("POST opportunity error", err);
      res.status(err.http || 500).json({ error: err.message });
    }
  });

  // GET /api/pipeline/contacts/search
  router.get("/contacts/search", async (req, res) => {
    try {
      const { locationId, query } = req.query;
      const client = getClient(req);
      const contacts = await searchContacts(client, locationId, query);
      res.json(contacts.map(c => ({
        id: c.id,
        name: c.name || c.contactName || c.firstName + " " + c.lastName || "Unknown",
        email: c.email || "",
        phone: c.phone || c.phone_number || ""
      })));
    } catch (err) {
      console.error("GET contacts search error", err);
      res.status(err.http || 500).json({ error: err.message });
    }
  });

  // PATCH /api/pipeline/opportunity/:id
  router.patch("/opportunity/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const locationId = req.query.locationId;
      const client = getClient(req);
      const { stageId, monetaryValue, notes } = req.body;
      
      const payload = {
        name: req.body.name, // Keep existing name if passed
        pipelineStageId: stageId,
        monetaryValue: typeof monetaryValue === "number" ? monetaryValue : undefined,
      };

      // Remove undefined values
      Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);

      if (notes !== undefined) {
        const notesFieldId = await resolveDbrNotesFieldId(client, locationId);
        if (notesFieldId) {
          payload.customFields = [{ id: notesFieldId, field_value: notes }];
        }
      }

      const updated = await updateOpportunity(client, id, payload);
      res.json(mapOpportunity(updated));
    } catch (err) {
      console.error("PATCH error", err);
      res.status(err.http || 500).json({ error: err.message });
    }
  });

  // Helper to map GHL opp to our tiny surface area
  function mapOpportunity(opp) {
    let notes = "";
    if (opp.customFields) {
      const notesField = opp.customFields.find(f => f.id === "dbr_notes" || f.name === "dbr_notes" || f.id?.includes("notes"));
      if (notesField) notes = notesField.field_value || "";
    }
    return {
      id: opp.id,
      name: opp.name,
      contact: {
        id: opp.contactId,
        name: opp.contact?.name || opp.contactName || "Unknown",
        phone: opp.contact?.phone || opp.contact?.phone_number || "",
        email: opp.contact?.email || ""
      },
      monetaryValue: opp.monetaryValue || 0,
      notes,
      updatedAt: opp.updatedAt || opp.createdAt
    };
  }

  return router;
}
