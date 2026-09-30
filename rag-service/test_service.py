import io
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
temp = tempfile.TemporaryDirectory()
os.environ['DATA_DIR'] = temp.name
os.environ['INTERNAL_SERVICE_TOKEN'] = 'test-only-service-token-not-for-deployment'
os.environ['MODEL_PROVIDER'] = 'mock'
os.environ.pop('SEARCH_ADAPTER_URL', None)
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import NameObject, DictionaryObject, DecodedStreamObject
import main

def pdf():
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    stream = DecodedStreamObject(); stream.set_data(b'BT /F1 12 Tf 20 200 Td (Workspace onboarding instructions) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    out=io.BytesIO();writer.write(out);return out.getvalue()

class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.client=TestClient(main.app)
        self.headers={'X-Service-Token':os.environ['INTERNAL_SERVICE_TOKEN']}
        with main.connect() as con:
            for table in ('documents','expert','sources'):con.execute('DELETE FROM '+table)
    def post(self,path,body):return self.client.post(path,json=body,headers=self.headers)
    def test_auth_and_empty_start(self):
        self.assertEqual(self.client.get('/v1/documents').status_code,401)
        self.assertEqual(self.client.get('/health').json()['documents'],0)
        self.assertEqual(self.client.get('/health').json()['mode'],'mock')
    def test_mock_no_network(self):
        with patch.object(main,'adapter',AsyncMock(side_effect=AssertionError('No network'))):
            result=self.post('/v1/drafts',{'question':'Example question'}).json()
        self.assertTrue(result['meta']['demo'])
        self.assertEqual(result['sources'],[])
        self.assertEqual(result['webSources'],[])
        self.assertIn('модель не подключена',result['text'])
    def test_pdf_lifecycle_and_retrieval(self):
        for i in range(2):
            res=self.client.post('/v1/documents',headers=self.headers,files={'file':('manual.pdf',pdf(),'application/pdf')})
            self.assertEqual(res.status_code,200,res.text)
        inventory=self.client.get('/v1/documents',headers=self.headers).json()['documents']
        self.assertEqual(len(inventory[0]['versions']),2)
        self.assertTrue(main.retrieve('onboarding')[0])
        self.assertEqual(self.post('/v1/documents/manual.pdf/versions/1/restore',{}).status_code,200)
        self.assertEqual(self.post('/v1/reindex',{}).status_code,200)
        self.assertEqual(self.client.delete('/v1/documents/manual.pdf',headers=self.headers).status_code,200)
        self.assertEqual(main.retrieve('onboarding')[0],[])
    def test_invalid_document_and_version(self):
        res=self.client.post('/v1/documents',headers=self.headers,files={'file':('../bad.pdf',b'%PDF-invalid','application/pdf')})
        self.assertEqual(res.status_code,400)
        self.assertEqual(self.post('/v1/documents/missing.pdf/versions/1/restore',{}).status_code,404)
    def test_expert_knowledge_and_deactivation(self):
        self.assertEqual(self.post('/v1/expert-knowledge',{'id':'test','question':'onboarding','answer':'Read handbook'}).status_code,200)
        self.assertTrue(main.retrieve('onboarding')[1])
        self.client.patch('/v1/expert-knowledge/test',json={'isActive':False},headers=self.headers)
        self.assertEqual(main.retrieve('onboarding')[1],[])
    def test_custom_model_and_search(self):
        calls=[]
        async def fake(url,key,body):
            calls.append(body)
            return {'sources':[{'url':'https://example.org/manual','title':'Manual','text':'Evidence'}]} if 'query' in body else {'text':'Grounded answer','metrics':{'totalTokens':12}}
        with patch.object(main,'PROVIDER','http'),patch.dict(os.environ,{'MODEL_ADAPTER_URL':'https://adapter.example.test/draft','SEARCH_ADAPTER_URL':'https://adapter.example.test/search'}),patch.object(main,'adapter',fake):
            result=self.post('/v1/drafts',{'question':'A question'}).json()
        self.assertEqual(result['text'],'Grounded answer')
        self.assertEqual(calls[1]['webSources'][0]['text'],'Evidence')
        self.assertEqual(result['meta']['metrics']['totalTokens'],12)
    def test_search_outage_is_explicit(self):
        with patch.dict(os.environ,{'SEARCH_ADAPTER_URL':'https://adapter.example.test/search'}),patch.object(main,'adapter',AsyncMock(side_effect=main.HTTPException(502,'Unavailable'))):
            result=self.post('/v1/drafts',{'question':'Question'}).json()
        self.assertEqual(result['meta']['searchStatus'],'unavailable')
    def test_routing_and_key_configuration(self):
        with patch.dict(os.environ,{'SPECIALIST_KEYWORDS':'engineering,architecture'}):
            self.assertEqual(self.post('/v1/classify',{'question':'engineering question'}).json()['reviewPool'],'SPECIALIST')
        self.assertEqual(self.client.put('/admin/api-key',json={'apiKey':'unused'},headers=self.headers).status_code,409)

if __name__=='__main__':unittest.main()
